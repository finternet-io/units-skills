/**
 * units-client.ts — dependency-free UNITS API client for Node 20+ (built-in fetch + node:crypto).
 *
 * SERVER-SIDE ONLY. The developer token identifies your whole organisation; never ship it to a
 * browser or mobile bundle. User session JWTs are bearer credentials too.
 *
 * What this file gives you (all verified against the UNITS wire protocol as of 2026-10):
 *   - envelope builder: every business call is POST /v1/... with
 *       { context: { id, version, ts, msgId, developerToken, authorization?, valueFormat? }, payload, signature? }
 *     The developer token and the user JWT travel IN THE BODY. No Authorization header is read.
 *   - call(): ok-check (HTTP 2xx AND context.status !== "failed"), error extraction from
 *     context.error {code, message}, 429 Retry-After handling, timeouts, X-Correlation-ID.
 *   - OTP login / signup helpers, address hashing (sha256(lower(trim(address))) hex).
 *   - RFC 8785 (JCS) canonicalisation + Ed25519 signing of `payload` for /v1/token/transact.
 *   - pollTransaction() with exponential backoff, resolveTokenId() (mint never returns tokenId).
 *   - ensureTokenClass(): idempotent get -> register for token class + token class config.
 *   - mint / addCredential / addProxy / transact helpers, reads, proofs, delegations.
 *   - SessionManager: refresh-token timer (< 30 min, single-flight; refresh tokens are single-use).
 *
 * Usage (Node 22.6+ can run .ts directly with --experimental-strip-types; Node 23.6+ by default;
 * otherwise compile with tsc):
 *
 *   import { UnitsClient } from "./units-client.ts";
 *   const units = new UnitsClient({
 *     baseUrl: process.env.UNITS_BASE_URL!,            // e.g. https://units.sanctum.finternetlab.io
 *     developerToken: process.env.UNITS_DEVELOPER_TOKEN!,
 *   });
 *
 * Verify everything against your live instance (/v1/tokenclassconfig/get, /v1/tokenprogram/search):
 * UNITS moves quickly and some behaviour is environment-dependent.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

export type ValueFormat = "raw" | "display";

export interface UnitsConfig {
  /** e.g. "https://units.sanctum.finternetlab.io" (no trailing slash needed). */
  baseUrl: string;
  /** base64("sa-<client-uuid>:<clientSecret>") issued by Finternet. Sent in context.developerToken. */
  developerToken: string;
  /** context.version. Spec says "1.0"; "v1" is also accepted live. */
  version?: string;
  /** Per-request timeout. Default 30 s. */
  timeoutMs?: number;
  /** Max automatic retries for retryable failures (429/502/503/504/network) on retry-safe calls. Default 3. */
  maxRetries?: number;
  /** Structured log sink. Secrets are redacted before this is called. */
  logger?: (event: UnitsLogEvent) => void;
}

export interface UnitsLogEvent {
  path: string;
  apiId: string;
  attempt: number;
  httpStatus: number;
  contextStatus?: string;
  errorCode?: string;
  errorMessage?: string;
  durationMs: number;
  correlationId?: string;
  msgId: string;
}

export interface Signature {
  /** id of an ACTIVE ed25519 key in the caller's key registry (/v1/account/keys/register|search). */
  keyId: string;
  /** standard base64 RAW Ed25519 signature over JCS(payload) — not a compact JWS despite the name. */
  jws: string;
}

export interface CallOptions {
  /** User session JWT ("Bearer " prefix optional) or the OTP JWT for /v1/account/create. */
  authorization?: string;
  /** Always set explicitly for amounts: "raw" = base-unit integer strings, "display" = decimals. */
  valueFormat?: ValueFormat;
  signature?: Signature;
  /** Optional X-Correlation-ID header (echoed back). Use your business id for traceability. */
  correlationId?: string;
  /** Override retry behaviour. Default: true for reads, false for writes (no idempotency key exists). */
  retry?: boolean;
  timeoutMs?: number;
  /** Sets context.debug = true (server records the request as trace attributes). */
  debug?: boolean;
}

export interface UnitsError {
  code: string;
  message: string;
}

export interface UnitsResult<T = unknown> {
  ok: boolean;
  httpStatus: number;
  /** context.status: "successful" | "accepted" | "failed" */
  contextStatus?: string;
  /** body.response — where UNITS puts the data (NOT body.payload). */
  data?: T;
  error?: UnitsError;
  correlationId?: string;
  msgId: string;
  /** Full response body (for logging/debugging). */
  raw: unknown;
}

export class UnitsApiError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly result: UnitsResult;
  constructor(result: UnitsResult, where: string) {
    const code = result.error?.code ?? `HTTP_${result.httpStatus}`;
    super(`${where}: ${code}: ${result.error?.message ?? "request failed"}`);
    this.name = "UnitsApiError";
    this.code = code;
    this.httpStatus = result.httpStatus;
    this.result = result;
  }
}

export interface LoginResponse {
  accessToken: string;
  tokenType?: string;
  expiresIn?: number;
  refreshToken?: string;
  refreshExpiresIn?: number;
  /** false => accessToken is an OTP JWT usable ONLY for /v1/account/create. */
  isExisting?: boolean;
}

export interface SessionTokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  refreshExpiresIn?: number;
}

export interface SubmitResponse {
  txId: string;
  status: string; // "submitted"
  message?: string;
  estimatedCompletionTime?: string;
  workflowInstanceId?: string;
}

export interface TxStatus {
  txId: string;
  status: string;
  error?: UnitsError;
  timestamps?: Record<string, string>;
}

export interface PollResult {
  txId: string;
  /** Last observed status. Terminal: completed | failed | cancelled. Actionable: awaiting_signature. */
  status: string;
  error?: UnitsError;
  timedOut: boolean;
  attempts: number;
  raw?: TxStatus;
}

export interface TokenClassDefinition {
  /** Payload for /v1/tokenclass/register. */
  register: Record<string, unknown> & { tokenClass: string; tokenStandard: string; name: string; schema: unknown };
  /** Payload for /v1/tokenclassconfig/register. tokenClassId is filled in automatically. */
  config: Record<string, unknown> & { programId: string };
}

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/** Path -> context.id convention. The server assigns the authoritative api id per route; this is echoed. */
export const API_IDS: Record<string, string> = {
  "/v1/account/login": "api.account.login",
  "/v1/account/create": "api.account.create",
  "/v1/account/refresh": "api.account.refresh",
  "/v1/account/get": "api.account.get",
  "/v1/account/logout": "api.account.logout",
  "/v1/account/keys/register": "api.account.keys.register",
  "/v1/account/keys/search": "api.account.keys.search",
  "/v1/account/keys/get": "api.account.keys.get",
  "/v1/address/checkAvailability": "api.address.checkAvailability",
  "/v1/address/resolve": "api.address.resolve",
  "/v1/tokenclass/register": "api.tokenclass.register",
  "/v1/tokenclass/get": "api.tokenclass.get",
  "/v1/tokenclass/search": "api.tokenclass.search",
  "/v1/tokenclass/update": "api.tokenclass.update",
  "/v1/tokenclassconfig/register": "api.tokenclassconfig.register",
  "/v1/tokenclassconfig/get": "api.tokenclassconfig.get",
  "/v1/tokenclassconfig/update": "api.tokenclassconfig.update",
  "/v1/tokenprogram/search": "api.tokenprogram.search",
  "/v1/tokenprogram/get": "api.tokenprogram.get",
  "/v1/token/mint": "api.token.mint",
  "/v1/token/add": "api.token.add",
  "/v1/token/transact": "api.token.transact",
  "/v1/token/get": "api.token.get",
  "/v1/token/search": "api.token.search",
  "/v1/token/transactions": "api.token.transactions",
  "/v1/transaction/status": "api.transaction.status",
  "/v1/transaction/get": "api.transaction.get",
  "/v1/transaction/search": "api.transaction.search",
  "/v1/transaction/proof": "api.transaction.proof",
  "/v1/transaction/proof/leaf": "api.transaction.proof.leaf",
  "/v1/transaction/proof/verify": "api.transaction.proof.verify",
  "/v1/transactions/status": "api.transactions.status",
  "/v1/delegations/list": "api.delegations.list",
  "/v1/delegations/check": "api.delegations.check",
  "/v1/workflows/execute": "api.workflow.execute",
  "/v1/workflows/status": "api.workflow.status",
};

/** Calls that are safe to retry automatically (reads, polling). Writes are NOT: no idempotency key. */
const RETRY_SAFE_PATHS = new Set<string>([
  "/v1/account/get",
  "/v1/account/keys/search",
  "/v1/account/keys/get",
  "/v1/address/checkAvailability",
  "/v1/address/resolve",
  "/v1/tokenclass/get",
  "/v1/tokenclass/search",
  "/v1/tokenclassconfig/get",
  "/v1/tokenprogram/search",
  "/v1/tokenprogram/get",
  "/v1/token/get",
  "/v1/token/search",
  "/v1/token/transactions",
  "/v1/transaction/status",
  "/v1/transaction/get",
  "/v1/transaction/search",
  "/v1/transaction/proof",
  "/v1/transaction/proof/leaf",
  "/v1/transaction/proof/verify",
  "/v1/transactions/status",
  "/v1/delegations/list",
  "/v1/delegations/check",
  "/v1/workflows/status",
]);

/** context.valueFormat is ONLY accepted on these routes; other routes' closed context schema rejects it (400). */
export const VALUE_FORMAT_PATHS = new Set<string>(["/v1/token/get", "/v1/token/search", "/v1/token/mint", "/v1/token/transact"]);

const RETRYABLE_HTTP = new Set([429, 502, 503, 504]);
const IN_FLIGHT_STATUSES = new Set(["submitted", "pending", "processing", "executing"]);
export const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

// ---------------------------------------------------------------------------------------------
// Identity helpers
// ---------------------------------------------------------------------------------------------

/**
 * The identity UNITS stores and authorises against: sha256(lower(trim(address))) as lowercase hex,
 * no 0x. Equals the session JWT's `preferred_username`. NOT the DID (did:units:0x<pubkey> is unrelated).
 * Record it at signup — /v1/account/get returns the address MASKED, so you cannot recover it later.
 */
export function hashAddress(plaintextAddress: string): string {
  return createHash("sha256").update(plaintextAddress.trim().toLowerCase(), "utf8").digest("hex");
}

/** Decode (WITHOUT verifying) a JWT payload. Use only to read claims of tokens UNITS just gave you. */
export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const raw = jwt.startsWith("Bearer ") ? jwt.slice(7) : jwt;
  const part = raw.split(".")[1];
  if (!part) throw new Error("not a JWT: missing payload segment");
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

/** `preferred_username` of a UNITS session JWT == hashAddress(account address). */
export function preferredUsernameFromJwt(jwt: string): string {
  const v = decodeJwtPayload(jwt)["preferred_username"];
  if (typeof v !== "string" || !v) throw new Error("JWT has no preferred_username claim");
  return v;
}

/** Address rule for /v1/account/create: lower-case [a-z0-9._-], max 255. */
export function isValidUnitsAddress(address: string): boolean {
  return /^[a-z0-9._-]{1,255}$/.test(address);
}

// ---------------------------------------------------------------------------------------------
// RFC 8785 JSON Canonicalization Scheme (JCS) + Ed25519 envelope signatures
// ---------------------------------------------------------------------------------------------

/**
 * RFC 8785 canonical JSON. Object keys sorted by UTF-16 code units (JS default sort), no whitespace,
 * numbers in ECMAScript shortest form (what JSON.stringify emits), strings escaped as JSON.stringify.
 * Keep amounts as STRINGS in payloads anyway — UNITS expects that.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new Error("JCS: non-finite numbers are not allowed");
      return JSON.stringify(value); // ES Number::toString == JCS number serialisation
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v === undefined ? null : v)).join(",")}]`;
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
    }
    default:
      throw new Error(`JCS: unsupported type ${typeof value}`);
  }
}

// PKCS#8 DER prefix for a raw 32-byte Ed25519 seed.
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/**
 * Signs envelope payloads with an Ed25519 key you control (self-custodied, e.g. kept in your KMS).
 * Register the public key once per UNITS account:
 *   POST /v1/account/keys/register { publicKey: signer.publicKeyHex(), type: "ed25519", name: "..." }
 * (with that account's session) and use the returned `id` as keyId.
 */
export class Ed25519Signer {
  readonly keyId: string;
  private readonly privateKey: KeyObject;

  constructor(privateKey: KeyObject, keyId: string) {
    if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Ed25519Signer needs an ed25519 private key");
    this.privateKey = privateKey;
    this.keyId = keyId;
  }

  static generate(keyId = ""): Ed25519Signer {
    return new Ed25519Signer(generateKeyPairSync("ed25519").privateKey, keyId);
  }

  static fromSeedHex(seedHex: string, keyId: string): Ed25519Signer {
    const seed = Buffer.from(seedHex.replace(/^0x/, ""), "hex");
    if (seed.length !== 32) throw new Error("Ed25519 seed must be 32 bytes (64 hex chars)");
    const key = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
    return new Ed25519Signer(key, keyId);
  }

  static fromPem(pem: string, keyId: string): Ed25519Signer {
    return new Ed25519Signer(createPrivateKey(pem), keyId);
  }

  withKeyId(keyId: string): Ed25519Signer {
    return new Ed25519Signer(this.privateKey, keyId);
  }

  /** 32-byte raw public key as hex — the `publicKey` for /v1/account/keys/register. */
  publicKeyHex(): string {
    const jwk = createPublicKey(this.privateKey).export({ format: "jwk" }) as { x?: string };
    if (!jwk.x) throw new Error("could not export public key");
    return Buffer.from(jwk.x, "base64url").toString("hex");
  }

  /** 32-byte seed as hex — store it in your secret manager, never in source control. */
  seedHex(): string {
    const jwk = this.privateKey.export({ format: "jwk" }) as { d?: string };
    if (!jwk.d) throw new Error("could not export private key");
    return Buffer.from(jwk.d, "base64url").toString("hex");
  }

  /** {keyId, jws}: standard-base64 raw Ed25519 signature over the JCS bytes of `payload`. */
  signPayload(payload: unknown): Signature {
    if (!this.keyId) throw new Error("Ed25519Signer has no keyId — register the key first");
    const bytes = Buffer.from(canonicalize(payload), "utf8");
    return { keyId: this.keyId, jws: cryptoSign(null, bytes, this.privateKey).toString("base64") };
  }
}

// ---------------------------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function bearer(token: string): string {
  return token.startsWith("Bearer ") ? token : `Bearer ${token}`;
}

function retryAfterMs(header: string | null, fallbackMs: number): number {
  if (!header) return fallbackMs;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : fallbackMs;
}

// ---------------------------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------------------------

export class UnitsClient {
  private readonly baseUrl: string;
  private readonly developerToken: string;
  private readonly version: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly logger?: (event: UnitsLogEvent) => void;

  constructor(cfg: UnitsConfig) {
    if (!cfg.baseUrl || !cfg.developerToken) throw new Error("UnitsClient: baseUrl and developerToken are required");
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
    this.developerToken = cfg.developerToken;
    this.version = cfg.version ?? "1.0";
    this.timeoutMs = cfg.timeoutMs ?? 30_000;
    this.maxRetries = cfg.maxRetries ?? 3;
    this.logger = cfg.logger;
  }

  /** Build the request envelope. A fresh msgId is generated on every call (and every retry). */
  buildEnvelope(path: string, payload: unknown, opts: CallOptions = {}): Record<string, unknown> {
    const context: Record<string, unknown> = {
      id: API_IDS[path] ?? `api${path.replace(/^\/v1/, "").replace(/\//g, ".")}`,
      version: this.version,
      ts: new Date().toISOString(),
      msgId: randomUUID(),
      developerToken: this.developerToken,
    };
    // context is additionalProperties:false — only add known keys.
    if (opts.authorization) context.authorization = bearer(opts.authorization);
    // valueFormat only where accepted (token get/search/mint/transact) — elsewhere it is a 400.
    if (opts.valueFormat && VALUE_FORMAT_PATHS.has(path)) context.valueFormat = opts.valueFormat;
    if (opts.debug) context.debug = true;
    const body: Record<string, unknown> = { context, payload: payload ?? {} };
    if (opts.signature) body.signature = opts.signature;
    return body;
  }

  /**
   * POST an envelope. Never throws for API-level failures — inspect `ok` / `error`.
   * Retries (fresh msgId each attempt) only when the call is retry-safe.
   */
  async call<T = unknown>(path: string, payload: unknown, opts: CallOptions = {}): Promise<UnitsResult<T>> {
    const retry = opts.retry ?? RETRY_SAFE_PATHS.has(path);
    const attempts = retry ? this.maxRetries + 1 : 1;
    let last: UnitsResult<T> | undefined;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const body = this.buildEnvelope(path, payload, opts);
      const msgId = (body.context as { msgId: string }).msgId;
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? this.timeoutMs);
      let httpStatus = 0;
      let raw: unknown = null;
      let networkError: string | undefined;
      let retryAfter: string | null = null;
      let correlationId: string | undefined;

      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (opts.correlationId) headers["X-Correlation-ID"] = opts.correlationId;
        const res = await fetch(`${this.baseUrl}${path}`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        httpStatus = res.status;
        retryAfter = res.headers.get("retry-after");
        correlationId = res.headers.get("x-correlation-id") ?? undefined;
        const text = await res.text();
        try {
          raw = text ? JSON.parse(text) : null;
        } catch {
          raw = { nonJson: text.slice(0, 500) };
        }
      } catch (e) {
        networkError = e instanceof Error ? e.message : String(e);
      } finally {
        clearTimeout(timer);
      }

      const ctx = (raw as { context?: { status?: string; error?: UnitsError } } | null)?.context;
      const contextStatus = ctx?.status;
      let error: UnitsError | undefined = ctx?.error;
      if (networkError) error = { code: "NETWORK_ERROR", message: networkError };
      else if (!error && (httpStatus < 200 || httpStatus >= 300)) {
        error = { code: `HTTP_${httpStatus}`, message: JSON.stringify(raw)?.slice(0, 300) ?? "" };
      }
      const ok = !networkError && httpStatus >= 200 && httpStatus < 300 && contextStatus !== "failed";

      last = {
        ok,
        httpStatus,
        contextStatus,
        data: (raw as { response?: T } | null)?.response,
        error: ok ? undefined : error,
        correlationId,
        msgId,
        raw,
      };

      this.logger?.({
        path,
        apiId: String((body.context as { id: string }).id),
        attempt,
        httpStatus,
        contextStatus,
        errorCode: last.error?.code,
        errorMessage: last.error?.message,
        durationMs: Date.now() - started,
        correlationId,
        msgId,
      });

      const retryable = !ok && (networkError !== undefined || RETRYABLE_HTTP.has(httpStatus));
      if (!retryable || attempt === attempts) break;
      const backoff = Math.min(30_000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
      await sleep(httpStatus === 429 ? retryAfterMs(retryAfter, backoff) : backoff);
    }
    return last as UnitsResult<T>;
  }

  /** Same as call() but throws UnitsApiError when !ok and returns `response` directly. */
  async callOrThrow<T = unknown>(path: string, payload: unknown, opts: CallOptions = {}): Promise<T> {
    const r = await this.call<T>(path, payload, opts);
    if (!r.ok) throw new UnitsApiError(r, path);
    return r.data as T;
  }

  // -------------------------------------------------------------------------------------------
  // Accounts / sessions
  // -------------------------------------------------------------------------------------------

  /** Step 1: send OTP to an email or E.164 phone. NOTE: may send a real email/SMS even on sandbox. */
  sendOtp(username: string): Promise<{ success?: boolean; message?: string }> {
    return this.callOrThrow("/v1/account/login", { username });
  }

  /**
   * Step 2: verify OTP. Sandbox (non-prod) accepts the fixed OTP "123456".
   * isExisting=true  -> real session (accessToken [+ refreshToken]).
   * isExisting=false -> accessToken is an OTP JWT, usable ONLY for createAccount().
   * Account homed on another instance -> 409 FORWARD (error message names the home instance).
   */
  verifyOtp(username: string, otp: string): Promise<LoginResponse> {
    return this.callOrThrow("/v1/account/login", { username, otp });
  }

  /**
   * Step 3 (new users only). address: ^[a-z0-9._-]+$ ; name: letters and spaces only;
   * entityType: "PERSONAL" | "BUSINESS". Persist address + hashAddress(address) NOW.
   */
  async createAccount(
    otpJwt: string,
    input: { address: string; name: string; entityType: "PERSONAL" | "BUSINESS" },
  ): Promise<SessionTokens & { address: string; addressHash: string }> {
    const address = input.address.trim().toLowerCase();
    if (!isValidUnitsAddress(address)) throw new Error(`invalid UNITS address: ${input.address}`);
    const tokens = await this.callOrThrow<SessionTokens>(
      "/v1/account/create",
      { address, name: input.name, entityType: input.entityType },
      { authorization: otpJwt },
    );
    const addressHash = hashAddress(address);
    // Sanity check: the session's preferred_username must equal the hash you store.
    let claimed: string | undefined;
    try {
      claimed = preferredUsernameFromJwt(tokens.accessToken);
    } catch {
      claimed = undefined; // token not decodable — skip the check, but log it in production
    }
    if (claimed !== undefined && claimed !== addressHash) {
      throw new Error("preferred_username != sha256(address) — do not proceed; investigate");
    }
    return { ...tokens, address, addressHash };
  }

  /**
   * Full login-or-signup. `otpProvider` returns the OTP the user typed (sandbox: "123456").
   * `signup` is used only if the account does not exist yet.
   */
  async loginOrSignup(
    username: string,
    otpProvider: () => Promise<string>,
    signup?: { address: string; name: string; entityType: "PERSONAL" | "BUSINESS" },
  ): Promise<{ session: SessionTokens; created: boolean; address?: string; addressHash?: string }> {
    await this.sendOtp(username);
    const login = await this.verifyOtp(username, await otpProvider());
    if (login.isExisting) {
      return { session: login, created: false, addressHash: preferredUsernameFromJwt(login.accessToken) };
    }
    if (!signup) throw new Error(`${username} has no UNITS account and no signup details were supplied`);
    const created = await this.createAccount(login.accessToken, signup);
    return { session: created, created: true, address: created.address, addressHash: created.addressHash };
  }

  /** Rotate the session. Refresh tokens are SINGLE-USE: reuse => 401 SESSION_REVOKED (re-login). */
  refresh(refreshToken: string): Promise<SessionTokens> {
    return this.callOrThrow("/v1/account/refresh", { refreshToken });
  }

  getAccount(session: string): Promise<Record<string, unknown>> {
    return this.callOrThrow("/v1/account/get", {}, { authorization: session });
  }

  /** Register a self-custodied Ed25519 public key; returns the key_references entry (its `id` is the keyId). */
  registerSigningKey(session: string, publicKeyHex: string, name = "envelope-signing"): Promise<{ id: string; status?: string }> {
    return this.callOrThrow("/v1/account/keys/register", { publicKey: publicKeyHex, type: "ed25519", name }, { authorization: session });
  }

  // -------------------------------------------------------------------------------------------
  // Token classes (synchronous registry calls)
  // -------------------------------------------------------------------------------------------

  /**
   * Idempotent: tokenclass/get -> register if missing; tokenclassconfig/get -> register if missing.
   * WITHOUT the config every operation fails "INVALID_INPUT: primitive_capability_missing".
   * Whoever registers a class OWNS it — call this with your OPERATOR account session.
   * Class names are global across tenants and upper-cased by the server.
   */
  async ensureTokenClass(
    def: TokenClassDefinition,
    operatorSession: string,
  ): Promise<{ tokenClass: string; tokenClassId: string; classCreated: boolean; configCreated: boolean; programId: string }> {
    const tokenClass = String(def.register.tokenClass).toUpperCase();
    const auth = { authorization: operatorSession };

    let classCreated = false;
    let cls = await this.call<{ id?: string }>("/v1/tokenclass/get", { tokenClass }, auth);
    if (!cls.ok || !cls.data?.id) {
      const reg = await this.call<{ id?: string }>("/v1/tokenclass/register", { ...def.register, tokenClass }, auth);
      if (reg.ok && reg.data?.id) {
        cls = reg;
        classCreated = true;
      } else if (reg.error?.code === "CONFLICT") {
        // Someone registered it meanwhile — or ANOTHER TENANT owns this name. If you don't own it,
        // later mints fail FORBIDDEN. Pick a unique prefix for your classes.
        cls = await this.call<{ id?: string }>("/v1/tokenclass/get", { tokenClass }, auth);
      } else {
        throw new UnitsApiError(reg, "tokenclass/register");
      }
    }
    const tokenClassId = cls.data?.id;
    if (!tokenClassId) throw new UnitsApiError(cls, "tokenclass/get");

    let configCreated = false;
    const programId = String(def.config.programId);
    const cfg = await this.call<{ programId?: string }>("/v1/tokenclassconfig/get", { tokenClass }, auth);
    if (cfg.ok) {
      if (cfg.data?.programId && cfg.data.programId !== programId) {
        throw new Error(`${tokenClass} is bound to program ${cfg.data.programId}, expected ${programId} (one config per class)`);
      }
    } else {
      await this.callOrThrow("/v1/tokenclassconfig/register", { ...def.config, tokenClass, tokenClassId }, auth);
      configCreated = true;
    }
    return { tokenClass, tokenClassId, classCreated, configCreated, programId };
  }

  // -------------------------------------------------------------------------------------------
  // Writes (all asynchronous: they return { txId, status: "submitted" } — poll before reporting success)
  // -------------------------------------------------------------------------------------------

  /**
   * /v1/token/mint. Caller (user JWT) must be an issuer of the class (the registering account is).
   * DO NOT send `identities` — UNITS stamps issuer/creator/owner from the caller; supplied ids get
   * re-hashed and the caller loses rights (later FORBIDDEN no_matching_allow_rule).
   * initialSupply is a string: "1" for NFT/loan/pool; base units (raw) or decimals (display) for FT.
   */
  async mint(
    session: string,
    payload: { tokenClass: string; initialSupply: string; metadata?: unknown; data?: unknown; claims?: unknown; extensions?: unknown },
    opts: { valueFormat?: ValueFormat; correlationId?: string } = {},
  ): Promise<SubmitResponse> {
    if ("identities" in (payload as Record<string, unknown>)) {
      throw new Error("mint(): do not pass identities[] (see comment)");
    }
    return this.callOrThrow("/v1/token/mint", payload, {
      authorization: session,
      valueFormat: opts.valueFormat ?? "raw",
      correlationId: opts.correlationId,
      retry: false,
    });
  }

  /**
   * /v1/token/add — credential branch, SESSIONLESS (developer token only). `owner` MUST be the
   * holder's address HASH (hashAddress(address)); wrong value => RESOURCE_NOT_FOUND "Owner address not found".
   * credentialSubject is a CLOSED KYC-shaped schema: id, documentType, country, faceMatchVerified (bool),
   * faceMatchPercentage (string) required; put domain data in credential.evidence[].rawPayload.
   * Poll the resulting txId with the OWNER's session (the operator gets FORBIDDEN).
   */
  addCredential(
    payload: {
      tokenClass: string;
      owner: string;
      credential: Record<string, unknown>;
      metadata: { name: string; tokenStandard: string };
    },
    opts: { correlationId?: string } = {},
  ): Promise<SubmitResponse> {
    if (!/^[0-9a-f]{64}$/.test(payload.owner)) {
      throw new Error("addCredential(): owner must be the sha256 hex hash of the holder's address");
    }
    return this.callOrThrow("/v1/token/add", payload, { correlationId: opts.correlationId, retry: false });
  }

  /**
   * /v1/token/add — proxy branch (e.g. USDC on Base). With the owner's session: creates (import) or,
   * if (owner, chain, contract, wallet) already exists, refreshes (reconcile). walletAddress must be an
   * active registered key of the owner; contractAddress must equal class metadata.contractIds[chainId].
   * value = base units string (USDC: 6 decimals).
   */
  addProxy(
    session: string,
    payload: { tokenClass: string; chainId: string; contractAddress: string; walletAddress: string; value?: string },
  ): Promise<SubmitResponse> {
    return this.callOrThrow("/v1/token/add", payload, { authorization: session, retry: false });
  }

  /**
   * /v1/token/transact — every post-creation operation (transfer, burn, freeze, lock, domain ops...).
   * Generic amount field is `value` (NOT `amount`). Signature: required when the instance has
   * signature enforcement on (environment-dependent) — pass a signer to always sign.
   */
  transact(
    session: string,
    payload: { operation: string; tokenId: string; [k: string]: unknown },
    opts: { signer?: Ed25519Signer; valueFormat?: ValueFormat; correlationId?: string } = {},
  ): Promise<SubmitResponse> {
    if ("amount" in payload) throw new Error("transact(): use `value`, not `amount` (domain ops put fields inside `data`)");
    return this.callOrThrow("/v1/token/transact", payload, {
      authorization: session,
      valueFormat: opts.valueFormat ?? "raw",
      signature: opts.signer ? opts.signer.signPayload(payload) : undefined,
      correlationId: opts.correlationId,
      retry: false,
    });
  }

  // -------------------------------------------------------------------------------------------
  // Results
  // -------------------------------------------------------------------------------------------

  /**
   * Poll /v1/transaction/status until the status leaves {submitted, pending, processing, executing}.
   * Use the session of the INITIATOR or of an identity on the token (for sessionless token/add: the OWNER).
   * Backoff: 1 s, x1.5, capped at 10 s; default overall timeout 120 s. Never report success on 202.
   */
  async pollTransaction(
    txId: string,
    session: string,
    opts: { timeoutMs?: number; initialDelayMs?: number; maxDelayMs?: number } = {},
  ): Promise<PollResult> {
    const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
    let delay = opts.initialDelayMs ?? 1_000;
    const maxDelay = opts.maxDelayMs ?? 10_000;
    let attempts = 0;
    let last: TxStatus | undefined;

    while (true) {
      attempts++;
      const r = await this.call<TxStatus>("/v1/transaction/status", { txId }, { authorization: session });
      if (!r.ok) {
        // 403 here almost always means "wrong session" (e.g. operator polling a token/add it didn't initiate).
        if (r.httpStatus === 401 || r.httpStatus === 403) throw new UnitsApiError(r, "transaction/status");
      } else if (r.data) {
        last = r.data;
        if (!IN_FLIGHT_STATUSES.has(r.data.status)) {
          return { txId, status: r.data.status, error: r.data.error, timedOut: false, attempts, raw: r.data };
        }
      }
      if (Date.now() + delay > deadline) {
        return { txId, status: last?.status ?? "unknown", error: last?.error, timedOut: true, attempts, raw: last };
      }
      await sleep(delay);
      delay = Math.min(maxDelay, Math.round(delay * 1.5));
    }
  }

  /**
   * Mint/add responses carry no tokenId. Resolution order:
   *   1. /v1/transaction/get -> response.metadata.token_id | metadata.affectedTokenIds[0] | responseData.tokenId | responseData.id (legacy)
   *   2. fallback /v1/token/search newest token of the class, narrowed by `dataFilter`
   *      (e.g. {"data.loanRefId": "LN-1"}) to avoid picking another concurrent mint.
   */
  async resolveTokenId(
    txId: string,
    session: string,
    fallback?: { tokenClass: string; dataFilter?: Record<string, unknown> },
  ): Promise<string | undefined> {
    const tx = await this.call<{ responseData?: Record<string, unknown>; metadata?: Record<string, unknown> }>(
      "/v1/transaction/get",
      { txId },
      { authorization: session },
    );
    if (tx.ok && tx.data) {
      const stamped = tx.data.metadata?.["token_id"]; // units-api stamp on create-op completion
      if (typeof stamped === "string" && stamped) return stamped;
      const affected = tx.data.metadata?.["affectedTokenIds"]; // engine
      if (Array.isArray(affected) && typeof affected[0] === "string") return affected[0];
      const rd = tx.data.responseData ?? {}; // legacy builds / proxy flows
      const fromRd = (rd["tokenId"] ?? rd["id"]) as string | undefined;
      if (fromRd) return fromRd;
    }
    if (!fallback) return undefined;
    const search = await this.call<{ tokens?: { id?: string }[] }>(
      "/v1/token/search",
      {
        filters: { tokenClass: fallback.tokenClass.toUpperCase(), ...(fallback.dataFilter ?? {}) },
        pagination: { limit: 1, offset: 0 },
        sortBy: { field: "createdAt", order: "desc" },
      },
      { authorization: session },
    );
    return search.data?.tokens?.[0]?.id;
  }

  /** submit -> poll -> resolve. Throws if the transaction does not complete. */
  async awaitCompletion(
    submitted: SubmitResponse,
    session: string,
    resolve?: { tokenClass: string; dataFilter?: Record<string, unknown> } | false,
    pollOpts: { timeoutMs?: number } = {},
  ): Promise<{ txId: string; status: string; tokenId?: string }> {
    const poll = await this.pollTransaction(submitted.txId, session, pollOpts);
    if (poll.timedOut) throw new Error(`tx ${submitted.txId} still ${poll.status} after timeout — keep polling later, do NOT resubmit blindly`);
    if (poll.status !== "completed") {
      throw new Error(`tx ${submitted.txId} ${poll.status}: ${poll.error?.code ?? ""} ${poll.error?.message ?? ""}`.trim());
    }
    const tokenId = resolve === false ? undefined : await this.resolveTokenId(submitted.txId, session, resolve || undefined);
    return { txId: submitted.txId, status: poll.status, tokenId };
  }

  // -------------------------------------------------------------------------------------------
  // Reads & proofs
  // -------------------------------------------------------------------------------------------

  /** 403 unless the caller is an identity on the token or holds a matching delegation. */
  getToken(session: string, tokenId: string, valueFormat: ValueFormat = "raw") {
    return this.callOrThrow<Record<string, unknown>>("/v1/token/get", { tokenId }, { authorization: session, valueFormat });
  }

  /** Always scoped to tokens where the caller is an identity. filters accepts dot-paths: data.*, metadata.*, state.* */
  searchTokens(session: string, filters: Record<string, unknown>, opts: { limit?: number; offset?: number; valueFormat?: ValueFormat } = {}) {
    return this.callOrThrow<{ tokens: Record<string, unknown>[]; pagination?: unknown }>(
      "/v1/token/search",
      { filters, pagination: { limit: opts.limit ?? 50, offset: opts.offset ?? 0 }, sortBy: { field: "createdAt", order: "desc" } },
      { authorization: session, valueFormat: opts.valueFormat ?? "raw" },
    );
  }

  tokenTransactions(session: string, tokenId: string, opts: { limit?: number; offset?: number } = {}) {
    return this.callOrThrow<{ tokenTransactions: Record<string, unknown>[] }>(
      "/v1/token/transactions",
      { filters: { tokenId }, pagination: { limit: opts.limit ?? 50, offset: opts.offset ?? 0 }, sortBy: { field: "createdAt", order: "desc" } },
      { authorization: session },
    );
  }

  getTransaction(session: string, txId: string) {
    return this.callOrThrow<Record<string, unknown>>("/v1/transaction/get", { txId }, { authorization: session });
  }

  /** proofStatus is often "pending" (Merkle batches only close when full). Chain anchoring is not implemented. */
  getProof(session: string, txId: string) {
    return this.callOrThrow<Record<string, unknown>>("/v1/transaction/proof", { txId }, { authorization: session });
  }

  // -------------------------------------------------------------------------------------------
  // Delegations (consent) — executed with the GRANTOR's session (the token owner)
  // -------------------------------------------------------------------------------------------

  /**
   * Grant view|transact|manage on a label to another account (grantee = PLAINTEXT address).
   * Labels: "tokens:id:<uuid>", "tokens:tokenclass:<CLASS>", "tokens:*".
   * Owner grants auto-activate; non-owner requests go pending until the owner approves.
   */
  grantDelegation(
    grantorSession: string,
    input: { granteeAddress: string; label: string; permission: "view" | "transact" | "manage"; expiresAt?: string; deny?: boolean },
  ) {
    const data: Record<string, unknown> = { grantee_address: input.granteeAddress, label: input.label, permission: input.permission };
    if (input.expiresAt) data.expires_at = input.expiresAt;
    return this.callOrThrow<{ workflowId?: string; status?: string }>(
      "/v1/workflows/execute",
      { workflow: "delegation-create", action: input.deny ? "deny" : "allow", data },
      { authorization: grantorSession, retry: false },
    );
  }

  revokeDelegation(grantorSession: string, delegationId: string) {
    return this.callOrThrow("/v1/workflows/execute", { workflow: "delegation-revoke", action: "revoke", data: { delegation_id: delegationId } }, {
      authorization: grantorSession,
      retry: false,
    });
  }

  listDelegations(session: string, filter: "granted_by_me" | "granted_to_me" | "pending") {
    return this.callOrThrow<{ delegations: Record<string, unknown>[] }>("/v1/delegations/list", { filter }, { authorization: session });
  }

  checkDelegation(session: string, tokenId: string) {
    return this.callOrThrow<Record<string, unknown>>("/v1/delegations/check", { tokenId }, { authorization: session });
  }
}

// ---------------------------------------------------------------------------------------------
// SessionManager — keeps one account's session alive (e.g. your operator account)
// ---------------------------------------------------------------------------------------------

/**
 * Keycloak settings observed on UNITS: access token ~10 h (expiresIn 36000), refresh idle timeout 30 min,
 * refresh tokens single-use (reuse kills the session with SESSION_REVOKED). So: refresh on a TIMER well
 * under 30 min, one refresh at a time (single-flight), and always store the NEW refresh token.
 * If the instance returns no refreshToken (older builds), the manager re-logs in via `relogin` before expiry.
 * Run ONE manager per account per process; share sessions across processes via a store + lock.
 */
export class SessionManager {
  private tokens: SessionTokens;
  private inFlight: Promise<SessionTokens> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private obtainedAt = Date.now();

  private readonly client: UnitsClient;
  private readonly relogin?: () => Promise<SessionTokens>;
  private readonly onTokens?: (t: SessionTokens) => void | Promise<void>;
  private readonly refreshEveryMs: number;

  constructor(
    client: UnitsClient,
    initial: SessionTokens,
    opts: {
      /** Called when refresh is impossible (no refresh token, SESSION_REVOKED). Must return a fresh session. */
      relogin?: () => Promise<SessionTokens>;
      /** Persist new tokens (encrypted) — e.g. to share with other workers. */
      onTokens?: (t: SessionTokens) => void | Promise<void>;
      /** Default 20 minutes (must stay below the 30-minute refresh idle timeout). */
      refreshEveryMs?: number;
    } = {},
  ) {
    this.client = client;
    this.tokens = initial;
    this.relogin = opts.relogin;
    this.onTokens = opts.onTokens;
    this.refreshEveryMs = opts.refreshEveryMs ?? 20 * 60_000;
  }

  start(): this {
    if (!this.timer) {
      this.timer = setInterval(() => {
        this.refreshNow().catch(() => undefined);
      }, this.refreshEveryMs);
      this.timer.unref?.();
    }
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Current access token (refreshes first if it is within 5 minutes of expiry). */
  async accessToken(): Promise<string> {
    const expiresAt = this.obtainedAt + (this.tokens.expiresIn ?? 36_000) * 1000;
    if (Date.now() > expiresAt - 5 * 60_000) await this.refreshNow();
    return this.tokens.accessToken;
  }

  /** Single-flight refresh. */
  refreshNow(): Promise<SessionTokens> {
    if (!this.inFlight) {
      this.inFlight = this.doRefresh().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async doRefresh(): Promise<SessionTokens> {
    let next: SessionTokens | undefined;
    if (this.tokens.refreshToken) {
      try {
        next = await this.client.refresh(this.tokens.refreshToken);
      } catch (e) {
        // SESSION_REVOKED (reuse detected) or UNAUTHORIZED (expired): fall through to relogin.
        if (!(e instanceof UnitsApiError)) throw e;
      }
    }
    if (!next) {
      if (!this.relogin) throw new Error("session cannot be refreshed and no relogin() was provided");
      next = await this.relogin();
    }
    this.tokens = next;
    this.obtainedAt = Date.now();
    await this.onTokens?.(next);
    return next;
  }
}

// ---------------------------------------------------------------------------------------------
// Minimal smoke run: `node units-client.ts selftest` (no network) — checks JCS + signing + hashing.
// ---------------------------------------------------------------------------------------------

if (process.argv[2] === "selftest") {
  const payload = { tokenId: "0199", operation: "burn", value: "10", data: { b: 1, a: [true, null, "é"] } };
  const canon = canonicalize(payload);
  if (canon !== '{"data":{"a":[true,null,"é"],"b":1},"operation":"burn","tokenId":"0199","value":"10"}') {
    throw new Error(`JCS mismatch: ${canon}`);
  }
  const signer = Ed25519Signer.generate("test-key");
  const sig = signer.signPayload(payload);
  const again = Ed25519Signer.fromSeedHex(signer.seedHex(), "test-key");
  if (again.publicKeyHex() !== signer.publicKeyHex() || again.signPayload(payload).jws !== sig.jws) {
    throw new Error("seed round-trip failed");
  }
  console.log("hashAddress('Alice.Example ') =", hashAddress("Alice.Example "));
  console.log("publicKeyHex =", signer.publicKeyHex(), "| jws =", sig.jws.slice(0, 16) + "...");
  console.log("selftest ok");
}
