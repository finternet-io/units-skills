# UNITS API Reference (units-api `/v1`)

Snapshot: 2026-10-03. Sources, in order of precedence: live sandbox behaviour (Aug 2026), then units-api code at HEAD (routers, `src/schemas/definitions/*.json`, registry `scope_apis` seed), then `specs/` OpenAPI, then public docs. Where the live sandbox and the code differ, this file says **environment-dependent**. Behaviour changes over time, so check against the instance you use: `/v1/tokenclassconfig/get` and `/v1/tokenprogram/search` show the real program bindings.

Base URLs: sandbox (staging "Sanctum") `https://units.sanctum.finternetlab.io`; prod `https://units.finternetlab.io`; dev "Foundry" `https://units.foundry.finternetlab.io` (may be unavailable); local `http://localhost:3000`. Swagger UI at `GET /v1/docs/*` is partly stale.

For credentials, onboarding, signing, scopes and delegations in depth, see `auth-and-onboarding.md`.

Contents
1. [Envelope specification](#1-envelope-specification)
2. [Conventions: ids, amounts, valueFormat, idempotency, async](#2-conventions)
3. [Search, pagination, sorting, filters](#3-search-pagination-sorting-filters)
4. [Status vocabularies](#4-status-vocabularies)
5. [Endpoint catalogue](#5-endpoint-catalogue)
   - 5.1 Health and well-known · 5.2 Accounts · 5.3 Address · 5.4 Keys and signing · 5.5 Tokens · 5.6 Transactions and proofs · 5.7 Token classes · 5.8 Token class configs · 5.9 Token programs · 5.10 Registry: chains, wallets, adapters · 5.11 Clients · 5.12 Scopes, approvals, user scopes · 5.13 Delegations · 5.14 Terms · 5.15 Workflows · 5.16 Internal / peer (not for integrators)
6. [Error code table](#6-error-code-table)
7. [Asynchronous (polled) error codes](#7-asynchronous-polled-error-codes)
8. [Removed / stale endpoints and fields](#8-removed--stale-endpoints-and-fields)

---

## 1. Envelope specification

### 1.1 Transport
- Every business endpoint is **`POST /v1/<path>`**, with header `Content-Type: application/json` and a JSON body envelope.
- Exceptions (unenveloped GET): `GET /v1/health`, `GET /v1/docs/*`, `GET /.well-known/ulip.json`, `GET /.well-known/jwks.json`. Every other GET route returns **401**, because a GET cannot carry `context.developerToken`.
- HTTP headers read by the server: only `X-Correlation-ID` (optional; generated if absent and always echoed in the response header). The developer token and user JWT travel **in the body**. The HTTP `Authorization`, `X-Developer-Token` and `X-Finternet-Signature` headers are **ignored**.

### 1.2 Request envelope

```json
{
  "context": {
    "id": "api.token.transact",
    "version": "1.0",
    "ts": "2026-10-03T10:00:00Z",
    "msgId": "5d7e3c1a-9b2f-4c8e-a1d0-6f4b2e9c7a13",
    "developerToken": "c2Et...",
    "authorization": "Bearer eyJhbGciOiJSUzI1NiIs...",
    "valueFormat": "raw",
    "transactionId": "0199...",
    "debug": false
  },
  "payload": { "operation": "burn", "tokenId": "0199a1b2-...", "value": "10", "reason": "redemption" },
  "signature": { "keyId": "0199c0de-2222-7aaa-8bbb-abcdefabcdef", "jws": "<std-base64 Ed25519 sig over JCS(payload)>" }
}
```

| `context` field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | **yes** | Api id, by convention `api.<domain>.<action>` (for example `api.token.mint`). It is echoed back. The server assigns the real api id per route and uses that for scopes and rate limits, so a wrong value is not rejected, but send the right one. |
| `version` | string | **yes** | `"1.0"` (spec). `"v1"` is also accepted live. |
| `ts` | string (RFC 3339 date-time) | **yes** | Client timestamp |
| `msgId` | string | **yes** | Unique per message. Use a fresh UUID for **every attempt**, retries included. It is echoed back. |
| `developerToken` | string | effectively yes | `base64("sa-<uuid>:<secret>")`. Without it you get 401. |
| `authorization` | string | per endpoint | `"Bearer <user session JWT>"`, or the OTP JWT on `/account/create` |
| `valueFormat` | `"raw"` \| `"display"` | no | **Only allowed on** `/token/get`, `/token/search`, `/token/mint`, `/token/transact`. See §2.3. |
| `transactionId` | uuid | no | Rarely used. The server sets it on async responses. |
| `debug` | boolean | no | `true` records the request context and payload as tracing attributes |
| `developerSignature` | string | no | Accepted by some schemas and **ignored** (an RFC 9421 developer signature was dropped). Do not send it. |

**Unknown keys**: most user-facing schemas (`/account/*` with a user, `/token/get|search|mint|transact|add`, `/clients/*`, `/delegations/*`, `/address/*`, `/users/scopes/*`, `/scope-approvals/`) declare `context` **closed** (`additionalProperties:false`). There, any unlisted key, including `valueFormat` where it isn't declared, returns **400 INVALID_INPUT**. Other schemas (class, config, program, registry, status, proof, search, terms) leave `context` open. Rule: **never send keys that aren't in the table above, and send `valueFormat` only on the four token endpoints.** Most `payload` objects are also closed. The exceptions are register/update for classes, configs, programs, chains, wallets and adapters, and `/workflows/execute` `data`.

Top-level `signature` is optional except on `/v1/token/transact` (see §5.5). If you send one on **any** route, it is verified, and a bad signature returns 401.

Validation order: auth (developer token, then scope, then rate limit, then user JWT, then user scope, then consent, then signature) runs **before** JSON-schema validation. So an unauthenticated malformed request returns 401 or 403, not 400.

### 1.3 Success response

```json
{
  "context": {
    "id": "api.token.transact", "version": "1.0", "ts": "2026-10-03T10:00:00Z",
    "msgId": "5d7e3c1a-9b2f-4c8e-a1d0-6f4b2e9c7a13",
    "transactionId": "0199b3c4-...", "status": "accepted"
  },
  "response": { "txId": "0199b3c4-...", "status": "submitted", "message": "...", "workflowInstanceId": "0199b3c4-..." }
}
```

- Data is under **`response`**, never `payload`.
- `context.status` is `"successful"` (HTTP 200 or 201) or `"accepted"` (HTTP 202: `/token/transact` and the first step of a workflow). Errors use `"failed"`.
- `context.ts` is server time. `msgId` is echoed. `transactionId` is set on async writes.
- **ok = HTTP 2xx AND `context.status != "failed"`.**

### 1.4 Error response

```json
{
  "context": {
    "id": "api.token.mint", "version": "1.0", "ts": "2026-10-03T10:00:00Z",
    "msgId": "5d7e3c1a-9b2f-4c8e-a1d0-6f4b2e9c7a13", "status": "failed",
    "error": { "code": "FORBIDDEN", "message": "user is not authorized to mint tokens for this class" }
  },
  "response": {}
}
```

- Only `code` and `message` are returned. Internal metadata (for example the FORWARD `api_url`, `program_id`, `capability_gate`, outstanding consent docTypes) is logged server-side and **not** returned.
- If the body could not be parsed, the context falls back to `{"id":"api.request","version":"v1","msgId":"9cba1b5e-ef63-4a9d-b51d-4b0c03737a32"}`.
- An unknown route returns 404 `RESOURCE_NOT_FOUND` "Endpoint Not Found".
- An async business failure (for example insufficient balance, or a bad loan field) is **not** an error envelope. The submit call returns 200 or 202, and the failure appears later in `/v1/transaction/status` → `response.status:"failed"`, `response.error:{code,message}`, with `context.status:"successful"`.

### 1.5 Auth legend used below

| Tag | Meaning |
|---|---|
| **SA** | Developer token in `context.developerToken` plus the SA scope check |
| **U** | User session JWT required (`context.authorization`). Without it: 401. |
| **U?** | User JWT optional |
| **U/SA** | User JWT, **or** SA-only, in which case the caller is the SA's owner address from the registry bundle |
| **OTP** | The OTP JWT from login-verify (`isExisting:false`) in `context.authorization` |
| **Sig** | Top-level `signature` required (enforcement is environment-dependent; always sign) |
| **C** | Consent gate (when `enableConsentEnforcement` is on): 403 `TERMS_CONSENT_REQUIRED` |
| **super** | The SA must be a superadmin, or the api id is unmapped so only a superadmin passes |

### 1.6 Minimal envelope helper (any language)

```
POST {BASE}{path}
Content-Type: application/json

{"context":{"id":"<api id>","version":"1.0","ts":"<now RFC3339>","msgId":"<uuid4>","developerToken":"<DEV>"[,"authorization":"Bearer <JWT>"][,"valueFormat":"raw"]},
 "payload":{...}
 [,"signature":{"keyId":"<uuid>","jws":"<b64>"}]}
```

In the examples below, `<DEV>` is your developer token, `<JWT>` is a session JWT, and `<uuid>` is a fresh UUID.

---

## 2. Conventions

### 2.1 Identifiers

| Thing | Format | Notes |
|---|---|---|
| `tokenId` | UUID (UUIDv7). `urn:uuid:<uuid>` is also accepted. | Mint does **not** return it. See §5.5.2. |
| `txId` | UUIDv7 | Also `context.transactionId`. Equals `workflowInstanceId` for transact. |
| token class key `tokenClass` | string, **upper-cased by the server** | Lookups are case-sensitive after upper-casing. That is why the seeded `USDe` and `crvUSD` are unreachable. |
| token class `id` (`tokenClassId`) | UUID | Returned by `/tokenclass/register` and `/tokenclass/get` |
| `keyId` | UUID of the `key_references` row | Returned by `/account/keys/register` as `response.id` |
| `clientId` | UUID. The Keycloak/SA id is `sa-<clientId>`. | |
| `delegation_id` | UUID | |
| `workflowId` | `<workflow-name>-<uuid>` | e.g. `profile-update-3f25...` |
| account address | lowercase handle `^[a-z0-9._-]+$` | Stored as `sha256(lower(trim(address)))` hex, which is also the JWT `preferred_username` |
| DID | `did:units:0x<ed25519 pubkey hex>` | Unrelated to the address hash |
| chain id | CAIP-2, e.g. `eip155:8453`, `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | |
| identity types (token/class `identities[].type`) | `issuer`, `creator`, `owner`, `co-owner`, `operator`, `viewer`, `access` (lowercase) | Any other value fails asynchronously with `INVALID_PAYLOAD unknown variant` |
| token `state.status` | **lowercase**: `active`, `frozen`, `burned`, `redeemed`, `expired`, `pending`, `rejected`, `transferred_out` | Engine `TokenStatus` (serde lowercase). Credential suspend shows as `frozen`, revoke as `burned`. Domain enums inside `data` are a different thing and are **PascalCase** (`loanEntityStatus: "Active"`, `disbursementStatus: "Full"`, voucher `"Created"`, pool `pool_status: "Active"`). Compare case-sensitively. |

### 2.2 Amounts and numbers
- Amounts are **strings**: `initialSupply`, `value`, balances, and all supply aggregates.
- Generic operations use the field **`value`** (not `amount`). Domain operations use their own field names inside `data`. Loan amount ops (`loan_disbursed`, `payment_received`, `charge_levied`, `penal_charge_levied`) use `data.value` in current code; older builds (e.g. sanctum Aug 2026) took `data.amount`, so this is **environment-dependent**.
- Loan u128 fields are integer strings with no decimals. u32 fields (tenure, emiDay, tranche, counts) are JSON numbers. Loan JSON keys are camelCase; loan-pool keys are snake_case.

### 2.3 `valueFormat`
- `"raw"`: base-unit integer strings (for example `"25500000"` for 25.5 USDC with 6 decimals).
- `"display"`: decimal strings converted with the class `metadata.decimals` (absent means 0).
- **The code default is `display`**, even though the schema text says raw. Always send `context.valueFormat` explicitly on `/token/mint`, `/token/transact`, `/token/get` and `/token/search`, and **only** on those four. On other closed-context schemas it causes a 400.
- It affects inputs (`initialSupply`, `value`, voucher `data.redemptions`) and outputs (token `state` balances and supplies, aggregates).
- `/token/add` proxy `value` is always base units. A transfer with `signed_lock_envelope` is always base units.

### 2.4 Idempotency and `msgId`
- There is **no idempotency key**. `msgId` is a trace id and is not deduplicated. A retried mint can create two tokens.
- Practice: carry your own business ids (`loanRefId`, order references) in `data` or `metadata`, check `/token/search` by that business id before retrying a write, and use a fresh `msgId` per attempt. Treat a 409 on duplicate registrations (class, config, sessionless proxy import) as "already done" and confirm with a get.

### 2.5 Async writes (no webhooks)
- `/token/mint` and `/token/add` return HTTP **200** with `response.status:"submitted"`. `/token/transact` returns **202** (`context.status:"accepted"`). None of them returns a tokenId.
- Poll `/v1/transaction/status {txId}` with the initiator's or owner's session: start at 1 s, back off, and set a timeout. Stop when the status is not in {`submitted`, `pending`, `processing`, `executing`}. Terminal states are `completed`, `failed` and `cancelled`. `awaiting_signature` means a proxy flow needs a user-signed chain transaction.
- Then call `/v1/transaction/get {txId}` and read `response.metadata.token_id`, then `metadata.affectedTokenIds[0]`, then legacy `responseData.tokenId` / `.id` (§5.5.2). As a fallback, call `/v1/token/search` sorted by `createdAt desc`.
- There are no webhooks, SSE or websockets. Never report success to a user on the 200 or 202.

---

## 3. Search, pagination, sorting, filters

| Element | Shape | Applies to |
|---|---|---|
| `pagination` | `{"limit": int, "offset": int}` (closed) | All `/search` endpoints, `/token/transactions`, `/account/keys/search` |
| limit bounds | `/token/search`: 1..1000, default 50. `/account/keys/search`: 1..200. Others: schema minimum 0 with no schema maximum (the registry spec says max 100, default 50). | |
| response pagination | `{"total": n, "limit": n, "offset": n}` | |
| `sortBy` | `{"field": "<column>", "order": "asc"\|"desc"}` (closed). Older docs use `sort`, which is renamed. | Default `createdAt desc`. Columns are accepted in camelCase (`createdAt`, `updatedAt`); `/token/transactions` also takes `timestamp`; registry entries take `name` and `priority`. |
| `filters` | free-form object | see below |

**Token search filters** (`/v1/token/search`):
- Direct columns: `id`, `tokenClass` (or `token_class`), `tokenStandard`, `tokenClassId`, `chainId` (CAIP-2), `contractId`, `walletAddress`, `stateVersion`.
- Dot-paths into the JSON roots: `data.<path>`, `metadata.<path>`, `state.<path>` (for example `"data.loanRefId":"LOAN-2026-001"`, `"metadata.tags.desk":"treasury"`, `"state.status":"active"`). Token `state.status` is lowercase; see §2.1.
- `identities` uses containment matching.
- Values can be strings, numbers, booleans or arrays. There is **no `isProxy` filter**; use `chainId`.
- Results are **always restricted** to tokens where the caller's hash is in `identities`, minus tokens excluded by a deny delegation.
- `groupBy: ["tokenClass"]` (the only value) switches to grouped output. `aggregateFields` ⊆ `["totalSupply","circulatingSupply","maxSupply","availableSupply","balance"]` are SUMmed per group and default to all of them.

```json
{"context":{"id":"api.token.search","version":"1.0","ts":"2026-10-03T10:00:00Z","msgId":"<uuid>","developerToken":"<DEV>","authorization":"Bearer <JWT>","valueFormat":"display"},
 "payload":{"filters":{"tokenClass":"ACME-PTS","metadata.tags.desk":"treasury"},
            "groupBy":["tokenClass"],"aggregateFields":["balance","totalSupply"],
            "pagination":{"limit":50,"offset":0},"sortBy":{"field":"createdAt","order":"desc"}}}
```
Flat result `{"tokens":[Token...],"pagination":{...}}`. Grouped result `{"tokens":[{"tokenClass":"ACME-PTS","aggregates":{"balance":"1500.00","totalSupply":"100000.00"},"records":[Token...]}],"pagination":{...}}`.

**Other filters**:
- `/transaction/search`: `status`, `correlationId`, `initiator`, `workflowInstanceId`, `dateRange:{from,to}`, plus JSON paths.
- `/token/transactions`: `filters` is **required**, with `tokenId`, `operation`, `entryType` (`debit`\|`credit`), `dateRange{from,to}`.
- Class, config and program searches: column names (`programId`, `status`, `tokenStandard`) and dot-paths such as `metadata.category`.
- Chains: `status`, `chainFamily`, `isTestnet`, `name`. Wallets: `status`, `name`, `rdns`, `supportedChains`. Adapters: `type`, `active`.

---

## 4. Status vocabularies

| Vocabulary | Values | Where |
|---|---|---|
| Envelope `context.status` | `successful` \| `accepted` \| `failed` (specs also list `pending`) | Every response |
| Transaction `status` | `submitted` → `pending` → `processing` (`executing` has also been seen) → `awaiting_signature` (proxy only) → **`completed`** \| **`failed`** \| **`cancelled`** | `/transaction/status`, `/transaction/get`, `/transaction/search` |
| Transaction `status_v2` (federation, internal) | `submitted`, `prepared`, `committing`, `committed`, `aborted`, `auto_reversing`, `reversed`, `stuck` (and `inbound` on peer rows) | DB / workflows |
| Federation status | `SUBMITTED`, `PREPARED`, `COMMITTING`, **`COMMITTED`**, **`ABORTED`**, `AUTO_REVERSING`, **`REVERSED`**, **`STUCK`** (or the workflow status upper-cased). Legacy mapping: completed→COMMITTED, failed/cancelled→ABORTED, awaiting_signature/processing→COMMITTING, everything else→SUBMITTED. | `/transactions/status` |
| Write submit `response.status` | `submitted` | mint, add, transact |
| Proof status | `pending` (batch not full; the usual case) \| `proven` \| `anchored` (**not implemented**: chain anchoring is not running) \| `failed` | `/transaction/proof` |
| Token ledger `entryType` | `debit` \| `credit` (a transfer writes both sides), `null` otherwise | `/token/transactions` |
| Delegation `status` | `pending`, `active`, `rejected`, `cancelled`, `revoked`, `expired`. `ruleType`: `allow` \| `deny`. `permission`: `view` \| `transact` \| `manage`. | delegations |
| Client `status` | `active` \| `inactive` (deactivated) | clients |
| Client scope `status` | `active` \| `pending` \| `rejected` | clients, scope approvals |
| Key `status` | `active` \| `superseded` \| `revoked`. `key_source`: `mpc` \| `vault_transit` \| `external`. | keys |
| Account `status` | `active`, `pending`, `migrating`, `frozen`, `suspended` | `/account/get` |
| Class / config / program `status` | `active` (only active rows are found); a config can be set to `suspended` | registry |
| Chain `status` | `ACTIVE` \| `INACTIVE` \| `DEPRECATED` | chains |
| Wallet provider `status` | `ACTIVE` \| `INACTIVE` \| `BLOCKED` | wallets |
| Terms `status` | `published` | terms |
| Workflow execute | `accepted` (start) \| `signaled` (later step) \| `cancelled` | workflows |
| Voucher token state (SODEXO-MV schema) | `Created`, `Active`, `Redeemed`, `Revoked`, `TransferredOut` | token state |
| Loan `loanEntityStatus` | `Active`, `Delinquent`, `NPA`, `WrittenOff`, `Closed` | LOAN-NFT data |

---

## 5. Endpoint catalogue

All paths are `POST` unless marked GET. In payload tables, `*` = required.

### 5.1 Health and well-known

| Method Path | Auth | Response |
|---|---|---|
| GET `/v1/health` | none | `200 {"status":"ok"}` (plain JSON, no envelope) |
| GET `/v1/docs/*` | none | Swagger UI (partly stale) |
| GET `/.well-known/ulip.json` | none | The instance's ULIP signing keys (house format) |
| GET `/.well-known/jwks.json` | none | RFC 7517 JWKS of the instance keys |

```bash
curl -s https://units.sanctum.finternetlab.io/v1/health      # {"status":"ok"}
```

### 5.2 Accounts

#### `/v1/account/login` · `api.account.login` · SA (OTP JWT optional fast path) · `accounts:manage`
Payload (closed; exactly one of three shapes): `username*` (email, or E.164 phone with `+` for SMS), `otp?` (string), `authToken?` (BFF-only SSO JWT; not usable by integrators). `otp` and `authToken` are mutually exclusive.

```json
{"context":{"id":"api.account.login","version":"1.0","ts":"2026-10-03T10:00:00Z","msgId":"<uuid>","developerToken":"<DEV>"},
 "payload":{"username":"alice@acme.com"}}
```
→ `{"response":{"success":true,"message":"OTP sent successfully"}}`

```json
{"context":{"id":"api.account.login","version":"1.0","ts":"2026-10-03T10:00:30Z","msgId":"<uuid>","developerToken":"<DEV>"},
 "payload":{"username":"alice@acme.com","otp":"123456"}}
```
→ existing account: `{"response":{"accessToken":"eyJ...","tokenType":"Bearer","expiresIn":36000,"refreshToken":"eyJ...","refreshExpiresIn":1800,"isExisting":true}}`
→ new contact: `{"response":{"accessToken":"<OTP JWT>","tokenType":"Bearer","expiresIn":<short>,"isExisting":false}}`. Use it on `/account/create`.
→ account homed elsewhere: 409 `FORWARD` (the message holds the home instance and its API URL).
Errors: 401 (`otp_invalid`), 429 (OTP rate limit, code `EXTERNAL_SERVICE_ERROR`), 503.

#### `/v1/account/create` · `api.account.create` · SA + **OTP** · `accounts:create`
Payload (closed): `address*` (`^[a-z0-9._-]+$`, lowercase, at most 255), `name*` (`^[\p{L} ]+$`, 1–100), `entityType*` (**`PERSONAL` \| `BUSINESS`**), `signedRegisterNameEnvelope?` (base64 ULIP envelope, self-custody path), `reservationProof?` (registrar proof JSON string), `homeInstance?` (ignored).

```json
{"context":{"id":"api.account.create","version":"1.0","ts":"2026-10-03T10:01:00Z","msgId":"<uuid>","developerToken":"<DEV>","authorization":"Bearer <OTP JWT>"},
 "payload":{"address":"alice.acme","name":"Alice Smith","entityType":"PERSONAL"}}
```
→ `{"response":{"accessToken":"eyJ...","tokenType":"Bearer","expiresIn":36000,"refreshToken":"eyJ...","refreshExpiresIn":1800}}`
Errors: 400 (schema), 401 (OTP JWT), 409 / `IDENTIFIER_TAKEN` (address taken). Record the plaintext address and its hash now.

#### `/v1/account/refresh` · `api.account.refresh` · SA (no user JWT) · `accounts:manage`
Payload (closed): `refreshToken*`.
```json
{"context":{"id":"api.account.refresh","version":"1.0","ts":"...","msgId":"<uuid>","developerToken":"<DEV>"},
 "payload":{"refreshToken":"eyJ..."}}
```
→ `{"response":{"accessToken":"...","tokenType":"Bearer","expiresIn":36000,"refreshToken":"<rotated>","refreshExpiresIn":1800}}`. Errors: 401 `UNAUTHORIZED` (expired or invalid), 401 `SESSION_REVOKED` (reuse; re-login). Refresh tokens are single-use, so refresh on a timer under 30 min with a lock.

#### `/v1/account/get` · `api.account.get` · SA + U · `accounts:view`
Payload `{}`.
```json
{"context":{"id":"api.account.get","version":"1.0","ts":"...","msgId":"<uuid>","developerToken":"<DEV>","authorization":"Bearer <JWT>"},"payload":{}}
```
→
```json
{"response":{"did":"did:units:0x5126a965...","address":"a***e","email":"a***@acme.com","name":"Alice Smith","phoneNumber":"+9***3210",
 "entityType":"PERSONAL","status":"active","vaultEntityID":"<sha256(accountId)>","homeInstance":"<instance uuid>","createdAt":"2026-10-03T10:01:00Z",
 "pii":{"address_encrypted":"vault:v1:...","address_masked":"a***e","email_encrypted":"vault:v1:...","email_masked":"a***@acme.com","mobile_encrypted":"vault:v1:...","mobile_masked":"+9***3210"},
 "consents":[{"docType":"terms_of_use","currentVersion":1,"acceptedVersion":1,"consentRequired":false}]}}
```
The address, email and phone are **masked**.

#### `/v1/account/pii/decrypt` · `api.account.pii.decrypt` · SA + U · `accounts:manage`
Payload (closed): `ciphertext*` (one of the caller's own `pii.*_encrypted` values). → `{"response":{"plaintext":"alice.acme"}}`. A ciphertext from another account returns 403.

#### `/v1/account/update` · `api.account.update` · SA + U + C · `accounts:manage`
Payload (closed): `action*` ∈ `initiate | verify_current_ownership | verify_new_email | verify_new_mobile | cancel`, `data*`:
- `initiate`: any of `{name, email, mobile}`, giving 202 `{"workflowId":"profile-update-<uuid>","status":"accepted"}`
- `verify_*`: `{workflowId*, otp* (at least 4 chars), recipient*}`, giving 200
- `cancel`: `{workflowId*}`, giving `{"workflowId":"...","status":"cancelled"}`

```json
{"context":{"id":"api.account.update","version":"1.0","ts":"...","msgId":"<uuid>","developerToken":"<DEV>","authorization":"Bearer <JWT>"},
 "payload":{"action":"initiate","data":{"email":"alice.b@acme.com"}}}
```

#### `/v1/account/logout` · `api.account.logout` · SA + U · `accounts:view`
Payload `{}` → `{"response":{"message":"Signout successful"}}`. This is a global Keycloak logout of the user, which ends all of their sessions.

#### `/v1/account/otp/generate` · `api.account.otp.generate` · SA + U · `accounts:manage`
Payload `{}` → `{"response":{"success":true,"message":"OTP sent successfully","data":{"status":"pending","to":"a***@acme.com","channel":"email"}}}`. The OTP goes to the signed-in user's own contact.

#### `/v1/account/otp/verify` · `api.account.otp.verify` · SA + U · `accounts:manage`
Payload (closed): `code*` (`^\d{6}$`). → `{"response":{"success":true,"message":"...","data":{"status":"verified","valid":true,"jwt":{"token":"...","expiresIn":300,"tokenType":"Bearer","issuer":"otp-service"}}}}`.

### 5.3 Address

#### `/v1/address/checkAvailability` · `api.address.checkAvailability` · SA · `accounts:view`
Payload (closed): `address*`.
```json
{"context":{"id":"api.address.checkAvailability","version":"1.0","ts":"...","msgId":"<uuid>","developerToken":"<DEV>"},"payload":{"address":"alice.acme"}}
```
→ `{"response":{"available":true}}`. Addresses taken on other federated instances report `false`.

#### `/v1/address/resolve` · `api.address.resolve` · SA · `accounts:view`
Payload (closed): `address*`. → `{"response":{"address":"alice.acme","did":"did:units:0x5126a965..."}}`. 404 `RESOURCE_NOT_FOUND` if unknown. This replaces `GET /v1/did/:address`, which is disabled.

### 5.4 Keys and signing

#### `/v1/account/keys/register` · `api.account.keys.register` · SA + U · `keys:create`
Payload (closed; exactly one of `publicKey` or `address`):

| field | type | notes |
|---|---|---|
| `type*` | `ed25519` \| `secp256k1` | Only ed25519 can sign envelopes |
| `publicKey` | hex (64/66/130, optional `0x`) or base58 (32–44) | For ed25519, send the raw 32 bytes as 64 hex chars |
| `address` | `^(0x[0-9a-fA-F]{40}\|[1-9A-HJ-NP-Za-km-z]{32,44})$` | EVM or Solana wallet address. A Solana address is treated as an ed25519 public key. |
| `name`, `isPrimary`, `isDefault` | string, bool, bool | `isPrimary` is per account and key type (proxy recipient resolution) |
| `wellKnownUrl` | string at most 2048 | `{url}/.well-known/jwks.json` may publish extra accepted keys |

```json
{"context":{"id":"api.account.keys.register","version":"1.0","ts":"...","msgId":"<uuid>","developerToken":"<DEV>","authorization":"Bearer <JWT>"},
 "payload":{"type":"ed25519","publicKey":"3f8a1c9d2b7e0f4a6c5d8e9b0a1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c","name":"acme-ops-signing"}}
```
→ 201
```json
{"response":{"id":"0199c0de-2222-7aaa-8bbb-abcdefabcdef","name":"acme-ops-signing","type":"ed25519","publicKeyHex":"3f8a...8b9c","address":"<derived>",
 "isPrimary":false,"isDefault":false,"did":"did:units:0x3f8a...","status":"active","wellKnownUrl":null,"createdAt":"...","updatedAt":"..."}}
```
`response.id` is the `keyId` for envelope signatures. The call is idempotent per (account, address). It also triggers async holdings discovery on matching chains, which auto-imports proxy tokens whose contract appears in a class's `metadata.contractIds`.

#### `/v1/account/keys/get` · `api.account.keys.get` · SA + U · `keys:view`
Payload (closed): exactly one of `id` (uuid) or `address`. → a `KeyRegistrationEntry` (as above). 404 if not found.

#### `/v1/account/keys/search` · `api.account.keys.search` · SA + U · `keys:view`
Payload (closed): `type?` (`ed25519`\|`secp256k1`), `status?`, `pagination?{limit 1..200, offset}`.
```json
{"context":{"id":"api.account.keys.search","version":"1.0","ts":"...","msgId":"<uuid>","developerToken":"<DEV>","authorization":"Bearer <JWT>"},
 "payload":{"type":"ed25519","status":"active","pagination":{"limit":20,"offset":0}}}
```
→ `{"response":{"keys":[KeyRegistrationEntry...],"pagination":{"total":2,"limit":20,"offset":0}}}`

#### `/v1/account/keys/remove` · `api.account.keys.remove` · SA + U · `keys:manage`
Payload (closed): exactly one of `id` or `address`. → `{"response":{"message":"Key removed successfully"}}`. The **default** key cannot be removed (409 "cannot remove the default key; set another key as default first").

#### `/v1/account/keys/create` · `api.account.keys.create` · SA + U · `keys:create`
No schema; payload `{}`. Provisions or returns the account's custodial Ed25519 key (custodied in Vault). It is idempotent, and the key normally already exists from sign-up. → 201 `{"response":{"keyId":"<uuid>","publicKey":"<hex>","did":"did:units:0x..."}}`. The private half stays in custody, so you **cannot** produce an envelope `jws` with this key yourself. It is only usable through `/v1/account/sign` (custodial, OTP-gated; see `auth-and-onboarding.md` §7.7). For self-signed envelopes, generate your own Ed25519 key and use `/v1/account/keys/register`. The `accountId` comes only from the user JWT.

#### `/v1/account/keys/rotate` · `api.account.keys.rotate` · SA + U · `keys:manage`
→ **501 NOT_IMPLEMENTED**. To rotate, register a new key and remove the old one.

#### GET `/v1/account/keys` · `api.account.keys.list`
**Unusable** (a GET can't carry the developer token, so it always returns 401). Use `/account/keys/search`.

#### `/v1/account/sign` · `api.account.sign` · SA (the OTP is the user gate) · `keys:manage`
A custodial OTP two-phase signature over `JCS(payload)` with the account's custodial key. The body is **non-standard** and not schema-validated:

```json
{"context":{"id":"api.account.sign","version":"1.0","ts":"...","msgId":"<uuid>","developerToken":"<DEV>",
            "method":"Transfer","account_did":"did:units:0x5126a965..."},
 "payload":{"operation":"transfer","tokenId":"0199a1b2-...","to":"bob-acme","value":"2550"},
 "username":"alice@acme.com"}
```
- Required: `context.method`, `context.account_did`, `payload`, and top-level `username` (the account's email or phone; it must hash-match). Errors: 400 "context.method is required", 400 "context.account_did is required", 400 "username is required for OTP verification", 401 "otp contact does not match account".
- Phase 1 (no `otp`) → `{"response":{"status":"otp_sent","message":"OTP sent. Resubmit with the otp field to complete signing."}}`
- Phase 2 (add `"otp":"123456"`) →
```json
{"response":{"envelope":{"context":{"ulip_version":"v1","method":"Transfer","txn_id":"<uuid>","op_seq":0,"caller_instance":"","callee_instance":"","sent_at":"..."},
                         "payload":{"type_url":"finternet.ulip.v1.Transfer","value":{...same payload...}},
                         "signature":{"signer_instance":"...","key_name":"<custodial key name>","algorithm":"ed25519","signature":"<b64 sig>"}},
             "keyId":"<uuid>","method":"Transfer"}}
```
- Use `{"keyId": response.keyId, "jws": response.envelope.signature.signature}` as the `signature` on `/token/transact`, with the same payload values.

### 5.5 Tokens

Program, standard and operation semantics (which operations exist per program, loan fields and so on) are covered in the token-model references. This section covers the wire contract.

#### 5.5.1 `/v1/token/mint` · `api.token.mint` · SA + U + C · `tokens:create` · async (HTTP 200)
Payload (closed):

| field | type | notes |
|---|---|---|
| `tokenClass*` | string | A registered class with a config. Upper-cased by the server. |
| `initialSupply*` | string | Per `valueFormat`. Use `"1"` for NFT, loan and pool tokens. |
| `metadata` | object (open) | `name`, `tags{k:v}`, `description`, `externalUrls`, and so on |
| `data` | object (open) | Program-specific. Validated by the program, not by the class `schema`. |
| `identities` | `[{id, type, roles?}]` | **Do not send.** Ids are re-hashed and the caller loses rights, giving later 403 `no_matching_allow_rule`. |
| `claims` | object[] | Initial verifiable claims (rarely used) |
| `extensions` | object | Only the class's own program-id namespace: `{"<programId>":{...}}`, with keys matching `[A-Za-z0-9._-]` and at most 128 characters |

Rules: the caller must hold an `issuer` identity on the class if the class has identities. Classes registered by you carry your account as owner and issuer. The program must support `mint`, otherwise you get 400 `operation_not_supported`. Without a class config you get 400 `primitive_capability_missing`.

```json
{"context":{"id":"api.token.mint","version":"1.0","ts":"2026-10-03T10:10:00Z","msgId":"<uuid>","developerToken":"<DEV>","authorization":"Bearer <operator JWT>","valueFormat":"display"},
 "payload":{"tokenClass":"ACME-PTS","initialSupply":"1000.00",
            "metadata":{"name":"ACME treasury float","tags":{"desk":"treasury","ref":"FLOAT-2026-10"}},
            "data":{"supply":{"total":"100000","circulating":"100000"}}}}
```
→
```json
{"context":{"id":"api.token.mint","version":"1.0","ts":"...","msgId":"...","transactionId":"0199b3c4-5d6e-7f80-9a1b-2c3d4e5f6a7b","status":"successful"},
 "response":{"txId":"0199b3c4-5d6e-7f80-9a1b-2c3d4e5f6a7b","status":"submitted","message":"domain_lifecycle_workflow_submitted","estimatedCompletionTime":"2026-10-03T10:10:30Z"}}
```
There is **no tokenId** in the response. `estimatedCompletionTime` is cosmetic (now + 30 s).

#### 5.5.2 Resolving the new tokenId
1. Poll `/v1/transaction/status {txId}` until it reaches `completed`.
2. Call `/v1/transaction/get {txId}` (same caller rules as status) and read, in this order:
   1. `response.metadata.token_id`: units-api (`StampCreateOpTokenID`, `services/federation.go`) backfills this when a create op (mint, add, import; federation method `Mint` or `DomainLifecycle`) completes. It is only written while empty, so it is the id of the token the op created. Present on units-api builds from Sep 2026.
   2. `response.metadata.affectedTokenIds[0]`: written by the engine on completion. For a single create op this is the new token. For multi-token ops (pool mint, transfer) it lists every token touched, so don't take `[0]` blindly there.
   3. `response.responseData.tokenId` / `.id`: older builds and demo code read this. Current code only fills `responseData` for proxy flows (`awaiting_signature`: `unsignedTx`, `tokenId`), so treat it as a legacy fallback.
   Store whichever you found, and check it with `/v1/token/get`.
3. Fallback: `/v1/token/search {"filters":{"tokenClass":"ACME-PTS","metadata.tags.ref":"FLOAT-2026-10"},"pagination":{"limit":1,"offset":0},"sortBy":{"field":"createdAt","order":"desc"}}` → `response.tokens[0].id`. Filter on your own business id to avoid races.

#### 5.5.3 `/v1/token/transact` · `api.token.transact` · SA + U/SA + C + **Sig** · `tokens:transact` · async (HTTP **202**)
Payload (closed):

| field | type | used by |
|---|---|---|
| `operation*` | string | `transfer`, `burn`, `freeze`, `unfreeze`, `lock`, `unlock`, `update`, `issue`, `redeem`, `revoke`, `suspend`, `resume`, loan ops (`loan_disbursed`, `payment_received`, `cersai_registered`, …), pool ops (`payout`, …). **All** lifecycle operations go through this endpoint. |
| `tokenId*` | string (UUID or `urn:uuid:`) | |
| `value` | string | Amount for transfer, burn, lock and unlock (**not** `amount`). NFT transfers use `"1"`. |
| `to` | string | Transfer recipient as a **plaintext address** |
| `toAddress` | string | Proxy transfers only: the recipient's on-chain wallet, which must be a registered key of the recipient |
| `category` | string | Voucher transfer split category |
| `reason`, `frozenBy`, `lockedBy` | string | |
| `lockUntil` | date-time | |
| `data` | object (open) | Domain-operation fields, the proxy `chainId`/`txHash`/`proxyProof`, voucher `redemptions` |
| `metadata` | object (open) | For `update` (`name`, `tags`, `description`) |
| `extensions` | object | `{"<programId>":{...}}` |
| `signed_lock_envelope` | object \| string \| null | User-signed Lock for federation transfers (forces base units) |

Top-level **`signature`** `{keyId, jws}` is required on environments that enforce transact signatures. Enforcement is **environment-dependent**, so always build signing in. The key must be active, ed25519, and belong to the session account. See `auth-and-onboarding.md` §7.

Authorization has two layers. **Client scope**: one scope per API id, so every operation on this endpoint (including `update`) needs only `tokens:transact`; `tokens:manage` is not checked here. **Resource action** (OPA, on the token's identities and delegations): `transact`, except `update`, which needs `manage` (`services/token.go`). The owner/issuer holds both; a delegate needs a `manage` delegation for `update`. The sender must be homed on this instance (otherwise 409 `CONFLICT` "sender account is homed on another instance"), and the program must support the operation (otherwise 400 `operation_not_supported` or `primitive_capability_missing`).

Transfer specifics: a transfer needs `to` and `value`. The class standard must be transfer-capable (UNITS-FT, ERC-20, ERC-3643, UNITS-NFT, ERC-721, UNITS-SFT, PROXY-FT). **CREDENTIAL, UNITS-Loan and UNITS-LoanPool cannot be transferred** (400 "federation transfer is not supported by this token program capability"). An NFT `value` must be `"1"` ("NFT federation transfer amount must be 1"). A voucher needs `category`, plus class `transferable:true` and config `voucherTransfer.enabled:true`. Proxy transfers need prior on-chain execution plus `data.chainId`, `data.txHash` (or `signedProxyTx`) and a confirmed `data.proxyProof`. **Live sanctum (Aug 2026): fungible transfers returned `recipient_address_not_found` for every recipient.** This is an open issue.

```json
{"context":{"id":"api.token.transact","version":"1.0","ts":"2026-10-03T10:20:00Z","msgId":"<uuid>","developerToken":"<DEV>","authorization":"Bearer <alice JWT>","valueFormat":"display"},
 "payload":{"operation":"transfer","tokenId":"0199a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b","to":"bob-acme","value":"25.50"},
 "signature":{"keyId":"0199c0de-2222-7aaa-8bbb-abcdefabcdef","jws":"q9Jx...==" }}
```
→ 202
```json
{"context":{"id":"api.token.transact","version":"1.0","ts":"...","msgId":"...","transactionId":"0199b3d5-...","status":"accepted"},
 "response":{"txId":"0199b3d5-...","status":"submitted","message":"Transfer workflow submitted for primitive orchestration","workflowInstanceId":"0199b3d5-..."}}
```
Other `message` values: "Domain lifecycle workflow submitted for primitive orchestration" and "Same-instance NFT ownership transfer submitted for primitive orchestration".

More payloads (each needs its own signature):
```json
{"operation":"burn","tokenId":"…","value":"10","reason":"redemption"}
{"operation":"freeze","tokenId":"…","reason":"compliance hold","frozenBy":"acme-ops"}
{"operation":"unfreeze","tokenId":"…","reason":"review complete"}
{"operation":"lock","tokenId":"…","value":"100","lockedBy":"escrow","lockUntil":"2026-12-31T00:00:00Z","reason":"escrow"}
{"operation":"unlock","tokenId":"…","value":"100","reason":"released"}
{"operation":"update","tokenId":"…","metadata":{"name":"New name","tags":{"tier":"gold"}}}
{"operation":"cersai_registered","tokenId":"<loan token>","data":{"regNumber":"CERSAI-LOAN-2026-001","cersaiDate":"2026-10-03"}}
{"operation":"loan_disbursed","tokenId":"<loan token>","data":{"tranche":1,"value":"37800","date":"2026-10-03","txId":"DISB-001","newDisbursementAmount":"37800","newPrincipalOutstanding":"37800","newDisbursementStatus":"Full"}}
{"operation":"payment_received","tokenId":"<loan token>","data":{"value":"1667","paymentDate":"2026-11-05","paymentType":"FullEMI","towards":{"principal":"1300","interest":"367","charges":"0"},"newPrincipalOutstanding":"36500","newOverdueAmount":"0","newDpd":0,"newEmisPaid":1,"newLoanEntityStatus":"Active"}}
{"operation":"redeem","tokenId":"<voucher>","data":{"redemptions":{"groceries":"150.00","meals":"50.00"}},"reason":"ORDER-123"}
{"operation":"transfer","tokenId":"<proxy>","to":"bob-acme","value":"5000000","toAddress":"0xBob...","data":{"chainId":"eip155:8453","txHash":"0xabc…","proxyProof":{"status":"confirmed","blockNumber":123}}}
```

#### 5.5.4 `/v1/token/add` · `api.token.add` · SA + U? · `tokens:create` · async (HTTP 200)
Imports or attaches an externally originated token. Payload (closed; one of two shapes A or B). **No `valueFormat` in context**, because it is a closed context and you would get a 400.

| field | type | notes |
|---|---|---|
| `tokenClass*` | string | e.g. your credential class, or `USDC` |
| `owner` | string | **sha256 address hash** (stored form) for sessionless B2B issuance. Omit it when a user JWT is present, in which case the owner is the session account. A mismatch returns 403, and an unknown hash returns 404 "Owner address not found". |
| **A: credential** `credential*` | W3C VC (closed) | `@context[]`, `type[]`, `issuer` (string or `{id,name}`), `validFrom`, `validUntil?`, `credentialSubject{ id*, documentType*, country*, faceMatchVerified* (bool), faceMatchPercentage* (string), givenName?, familyName?, documentNumber?, documentExpired?, dateOfBirth?, address?, gender? }` (closed, KYC-shaped), `evidence?[{type[], rawPayload{…any…}}]`. Put domain data in `evidence[].rawPayload`. |
| A `metadata*` | `{name, tokenStandard}` (closed) | e.g. `{"name":"KYC Credential","tokenStandard":"UNITS-CREDENTIAL"}` |
| **B: proxy** `chainId*` | CAIP-2 `^[a-z0-9]+:[a-zA-Z0-9._-]+$` | |
| B `contractAddress*` | string | Must equal the class `metadata.contractIds[chainId]` (case-insensitive) |
| B `walletAddress*` | string | Must be an active registered key of the owner |
| B `value` | `^[0-9]+$` base units | Required on create. A duplicate add with a session triggers `reconcile` (balance refresh); a duplicate sessionless add returns 409. |

```json
{"context":{"id":"api.token.add","version":"1.0","ts":"2026-10-03T10:30:00Z","msgId":"<uuid>","developerToken":"<DEV>"},
 "payload":{"tokenClass":"ACME-KYC","owner":"7cf569d8e1...<64 hex>",
   "credential":{"@context":["https://www.w3.org/ns/credentials/v2"],"type":["VerifiableCredential","KYCCredential"],
     "issuer":{"id":"did:web:acme.example","name":"Acme KYC"},"validFrom":"2026-10-03T10:30:00Z","validUntil":"2027-10-03T10:30:00Z",
     "credentialSubject":{"id":"7cf569d8e1...<64 hex>","documentType":"PAN","country":"IN","faceMatchVerified":true,"faceMatchPercentage":"98.5","givenName":"Alice"},
     "evidence":[{"type":["KYCEvidence"],"rawPayload":{"provider":"acme-kyc","ref":"KYC-2026-0001"}}]},
   "metadata":{"name":"KYC Credential","tokenStandard":"UNITS-CREDENTIAL"}}}
```
→ `{"response":{"txId":"0199...","status":"submitted","message":"credential_add_transaction_submitted","estimatedCompletionTime":"..."}}`. Other messages: `proxy_token_import_submitted`, `proxy_token_refresh_submitted`. **Poll with the owner's session**; other callers get 403.

Proxy example payload: `{"tokenClass":"USDC","chainId":"eip155:84532","contractAddress":"0x036CbD53842c5426634e7929541eC2318f3dCF7e","walletAddress":"0xAlice…","value":"25000000"}`.

#### 5.5.5 `/v1/token/get` · `api.token.get` · SA + U/SA · `tokens:view`
Payload (closed): `tokenId*`. Context may carry `valueFormat`. 403 unless the caller is an identity on the token or holds a delegation.
```json
{"context":{"id":"api.token.get","version":"1.0","ts":"...","msgId":"<uuid>","developerToken":"<DEV>","authorization":"Bearer <JWT>","valueFormat":"raw"},
 "payload":{"tokenId":"0199a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b"}}
```
→
```json
{"response":{"id":"0199a1b2-...","tokenClass":"ACME-PTS",
 "tokenClassInfo":{"tokenStandard":"UNITS-FT","name":"ACME Loyalty Points","description":"...","metadata":{"decimals":2,"symbol":"ACME"}},
 "chainRegistryInfo":null,
 "metadata":{"name":"ACME treasury float","tags":{"desk":"treasury"}},
 "data":{"supply":{"total":"100000","circulating":"100000"}},
 "claims":null,
 "identities":[{"id":"<sha256 addr>","type":"owner","name":"Acme Ops"},{"id":"<sha256 addr>","type":"issuer"}],
 "state":{"balance":"100000","status":"active"}}}
```
For proxy tokens, `chainRegistryInfo` = `{name, chainFamily, status, metadata}`.

#### 5.5.6 `/v1/token/search` · `api.token.search` · SA + U · `tokens:view`
See §3 for the payload. → `{"response":{"tokens":[Token...],"pagination":{"total","limit","offset"}}}` (or the grouped form).

#### 5.5.7 `/v1/token/transactions` · `api.token.transactions` · SA + U · `tokens:view`
Payload: `filters*` `{tokenId?, operation?, entryType? (debit|credit), dateRange?{from,to}}`, `pagination?`, `sortBy?`.
```json
{"context":{"id":"api.token.transactions","version":"1.0","ts":"...","msgId":"<uuid>","developerToken":"<DEV>","authorization":"Bearer <JWT>"},
 "payload":{"filters":{"tokenId":"0199a1b2-..."},"pagination":{"limit":50,"offset":0},"sortBy":{"field":"createdAt","order":"desc"}}}
```
→ `{"response":{"tokenTransactions":[{"id","txId","tokenId","tokenClass","tokenClassInfo","operation","entryType","identities","participants","units","stateBefore","stateAfter","proofId","timestamp","metadata","signature","createdAt"}],"pagination":{...}}}`. A transfer produces two rows with the same txId (`debit` for the sender, `credit` for the recipient).

### 5.6 Transactions and proofs

#### `/v1/transaction/status` · `api.transaction.status` · SA + U · `tokens:view`
Payload (closed): `txId*`. The caller must be the initiator or an identity on the transaction. For `/token/add`, use the owner's session.
```json
{"context":{"id":"api.transaction.status","version":"1.0","ts":"...","msgId":"<uuid>","developerToken":"<DEV>","authorization":"Bearer <JWT>"},
 "payload":{"txId":"0199b3c4-5d6e-7f80-9a1b-2c3d4e5f6a7b"}}
```
→ `{"response":{"txId":"0199b3c4-...","status":"completed","timestamps":{"submitted":"...","started":"...","completed":"...","finalized":"..."}}}`
→ on failure: `{"response":{"txId":"...","status":"failed","error":{"code":"UNSUPPORTED_TOKEN_STANDARD","message":"..."},"timestamps":{"submitted":"...","failed":"..."}}}`. The envelope `context.status` is still `successful`.

#### `/v1/transaction/get` · `api.transaction.get` · SA + U · `tokens:view`
Payload (closed): `txId*`. → `{"response":{"txId","correlationId","initiator","workflowInstanceId","status","error","responseData":{"tokenId":"0199a1b2-..."},"timestamps","proofId","proofProfile","batchId","operationName":"mint","metadata":{"token_class_id","token_id","operation","affectedTokenIds":[...]},"identities":[...],"createdAt","updatedAt"}}`. For proxy flows, `responseData` may carry `unsignedTx` (while `awaiting_signature`) or `chainTxHash`.

#### `/v1/transaction/search` · `api.transaction.search` · SA + U · `tokens:view`
Payload: `filters?` (`status`, `correlationId`, `initiator`, `workflowInstanceId`, `dateRange{from,to}`, JSON paths), `pagination?`, `sortBy?`.
```json
{"context":{"id":"api.transaction.search","version":"1.0","ts":"...","msgId":"<uuid>","developerToken":"<DEV>","authorization":"Bearer <JWT>"},
 "payload":{"filters":{"status":"completed"},"pagination":{"limit":50,"offset":0},"sortBy":{"field":"createdAt","order":"desc"}}}
```
→ `{"response":{"transactions":[TransactionResponse...],"pagination":{...}}}`. Results can include failed attempts. Filter client-side as needed.

#### `/v1/transactions/status` (plural) · `api.transactions.status` · **SA only** · `tokens:view`
Payload: `{"txn_id":"<txId>"}` (**snake_case**). This is SA-level federation/saga status keyed by `txn_id`. Integrators should prefer `/v1/transaction/status` for status polling.
```json
{"context":{"id":"api.transactions.status","version":"1.0","ts":"...","msgId":"<uuid>","developerToken":"<DEV>"},"payload":{"txn_id":"0199b3d5-..."}}
```
→ `{"response":{"txn_id":"0199b3d5-...","workflow_name":"transfer","status":"COMMITTED","ops":[{"op_seq":0,"op_type":"Lock","result":{...},"details":{...},"created_at":"..."}],"last_error":null,"created_at":"...","updated_at":"..."}}`. 404 if no transaction row exists.

#### `/v1/transaction/proof` · `api.transaction.proof` · SA + U? · `tokens:view`
Payload (closed): `txId*`. → `{"response":{"txId","merkleRoot","leafHash","leafIndex","proofPath":[{"hash","direction":"left|right"}],"stateCommitment","proofStatus":"pending|proven|anchored","ledgerAnchors":[{chain,network,txHash,blockId,slot,timestamp}],"message","verificationEndpoints":{"leafDataEndpoint":"/v1/transaction/proof/leaf"}}}`. On the sandbox the status is usually `pending`, with message "Transaction awaiting proof generation." Merkle batches are generated only when a batch fills, and **chain anchoring is not implemented**. Every write does compute a hash-chained `stateCommitment` (sha256 by default, or blake3), so describe the result as "hash-chained, tamper-evident", not "anchored on blockchain".

#### `/v1/transaction/proof/leaf` · `api.transaction.proof.leaf` · SA + U? · `tokens:view`
Payload `{txId*}` → `{"response":{"txId","leafHash","stateCommitment","tokenId","tokenClass","operation","timestamp","rawData":{...}}}`.

#### `/v1/transaction/proof/verify` · `api.transaction.proof.verify` · SA + U? · `tokens:view`
Payload `{txId*}` → `{"response":{"txId","valid","leafHashValid","proofPathValid","anchorValid":null,"message"}}`. The check is **structural only**.

### 5.7 Token classes

Aliases: `/v1/registry/tokenclasses/{register,update,get,search}` (`api.registry.tokenclasses.*`) use the same controllers and scopes.

#### `/v1/tokenclass/register` · `api.tokenclass.register` · SA + U/SA · `tokenClasses:create` · synchronous
Payload (open):

| field | type | notes |
|---|---|---|
| `tokenClass*` | string | Stored UPPER-CASE. Unique. |
| `tokenStandard*` | string | Must be in the program's whitelist (e.g. `UNITS-FT`, `UNITS-NFT`, `UNITS-CREDENTIAL`, `PROXY-FT`, `UNITS-Loan`, `UNITS-LoanPool`, `UNITS-SFT`). A mismatch fails only at poll time with `UNSUPPORTED_TOKEN_STANDARD`. |
| `name*` | string | |
| `description` | string | |
| `schema*` | object | JSON Schema for documentation only. It is **not enforced**. `{"type":"object"}` is fine. |
| `identities` | `[{id (plaintext), type, roles?}]` | Omitted **or `[]`** means the caller is stamped owner and issuer (len==0 check). A class whose *stored* identities are `[]` (for example one later updated to `[]`) is open for minting by any authenticated user, so don't update identities to `[]`. |
| `metadata` | object | `decimals` (used for display↔raw), `symbol`, `category`, `fungible`, `transferable`, `divisible`, `burnable`, `revocable`, `soulbound`, `contractIds{CAIP-2→address}`, `maxSupply`, `minBalance`, `valuation`, … |

```json
{"context":{"id":"api.tokenclass.register","version":"1.0","ts":"...","msgId":"<uuid>","developerToken":"<DEV>","authorization":"Bearer <operator JWT>"},
 "payload":{"tokenClass":"ACME-PTS","tokenStandard":"UNITS-FT","name":"ACME Loyalty Points","description":"Loyalty points",
   "schema":{"type":"object"},
   "metadata":{"decimals":2,"symbol":"ACME","fungible":true,"category":"utility","transferable":true,"divisible":true,"burnable":true,"revocable":false,"soulbound":false}}}
```
→ `{"response":{"id":"01a003b8-7960-7abc-8def-0123456789ab","tokenClass":"ACME-PTS","tokenStandard":"UNITS-FT","name":"ACME Loyalty Points","description":"Loyalty points","schema":{"type":"object"},"identities":[{"id":"<hash>","type":"owner"},{"id":"<hash>","type":"issuer"}],"metadata":{...},"status":"active","createdAt":"...","updatedAt":"..."}}`. A duplicate returns 409 `CONFLICT` "Token class already exists". `chainDeployments` and `status` in old examples are ignored.

#### `/v1/tokenclass/update` · `api.tokenclass.update` · SA + U · `tokenClasses:manage`
Payload (open): `tokenClass*` plus optional `tokenStandard`, `name`, `description`, `schema`, `identities` (propagated to the config), `metadata` (a **full replace** of the JSON), `status`. The caller needs manage access on the class.

#### `/v1/tokenclass/get` · `api.tokenclass.get` · SA (+U?) · `tokenClasses:view`
Payload (closed): `tokenClass*`.
```json
{"context":{"id":"api.tokenclass.get","version":"1.0","ts":"...","msgId":"<uuid>","developerToken":"<DEV>","authorization":"Bearer <JWT>"},"payload":{"tokenClass":"ACME-PTS"}}
```
→ the TokenClass, as above. 404 `RESOURCE_NOT_FOUND` "Token class not found".

#### `/v1/tokenclass/search` · `api.tokenclass.search` · SA (+U?) · `tokenClasses:view`
Payload: `{filters?, pagination?, sortBy?}` → `{"response":{"tokenClasses":[...],"pagination":{...}}}`. Example filter: `{"tokenStandard":"UNITS-FT","metadata.category":"utility"}`.

### 5.8 Token class configs

#### `/v1/tokenclassconfig/register` · `api.tokenclassconfig.register` · SA + U · `tokenClassConfigs:create` · synchronous
Payload (open): `tokenClass*`, `tokenClassId*` (uuid from the class), `programId*` (`fungible`, `non-fungible`, `credential`, `stables`, `purpose-bound-voucher`, `loan-nft-program`, `loan-pool-nft-program`, `hello-token`), `preHooks?` `[{hookId, priority, enabled, operations?}]`, `postHooks?`, `operationOverrides?` (stored but **not enforced**), `config?` (`stateCommitmentAlgorithm`, `stateCommitmentFields`, `includeDataInCommitment`, `additionalStateRequirements`, `credentialVerification`, `voucherTransfer`, `defaultValidityDays`). There is one config per class, and **without a config every operation fails** with `primitive_capability_missing`.

```json
{"context":{"id":"api.tokenclassconfig.register","version":"1.0","ts":"...","msgId":"<uuid>","developerToken":"<DEV>","authorization":"Bearer <operator JWT>"},
 "payload":{"tokenClass":"ACME-PTS","tokenClassId":"01a003b8-7960-7abc-8def-0123456789ab","programId":"fungible",
   "preHooks":[{"hookId":"validation","priority":10,"enabled":true}],
   "postHooks":[{"hookId":"logging","priority":1,"enabled":true}],
   "config":{"stateCommitmentAlgorithm":"sha256"}}}
```
→ `{"response":{"id":"<uuid>","tokenClass":"ACME-PTS","tokenClassId":"01a003b8-...","programId":"fungible","preHooks":[...],"postHooks":[...],"operationOverrides":{},"config":{...},"identities":[...copied from class...],"status":"active","createdAt":"...","updatedAt":"..."}}`. A duplicate returns 409.

#### `/v1/tokenclassconfig/update` · `api.tokenclassconfig.update` · SA + U · `tokenClassConfigs:manage`
Payload (open): `tokenClass*` plus optional `programId`, `preHooks`, `postHooks`, `operationOverrides`, `config`, `status`. Arrays are **replaced whole**.

#### `/v1/tokenclassconfig/get` · `api.tokenclassconfig.get` · SA · `tokenClassConfigs:view`
Payload (closed): `tokenClass*` → the config. Use it to discover the real program of any class (for example seeded `LOAN-NFT` → `loan-nft-program`).

#### `/v1/tokenclassconfig/search` · `api.tokenclassconfig.search` · SA · `tokenClassConfigs:view`
Payload `{filters?, pagination?, sortBy?}` → `{"response":{"tokenClassConfigs":[...],"pagination":{...}}}`. Example filter: `{"programId":"fungible"}`.

### 5.9 Token programs

Programs are Rust code in the token engine and self-register at boot. The API rows describe them, but **cannot make an operation executable**. Integrators choose a program; they do not deploy one.

#### `/v1/tokenprogram/get` · `api.tokenprogram.get` · SA · `registry-programs:view`
Payload (closed): `programId*` → `{"response":{"id","programId":"fungible","name","description","version":"1.0.0","supportedStandards":["UNITS-FT","ERC-20","ERC-3643"],"supportedOperations":[...],"config":{...,"selfRegistered":true},"identities","status":"active","createdAt","updatedAt"}}`.

#### `/v1/tokenprogram/search` · `api.tokenprogram.search` · SA · `registry-programs:view`
Payload `{filters?, pagination?, sortBy?}` → `{"response":{"tokenPrograms":[...],"pagination":{...}}}`. This is the authoritative list of what the instance runs.

#### `/v1/tokenprogram/register` · `api.tokenprogram.register` · SA + U · `registry-programs:create`
Payload (open): `programId*`, `name*`, `version*`, `supportedStandards*[]`, `supportedOperations*[]`, `description?`, `config?`. A duplicate returns 409. **Not useful to integrators**: it creates a row only.

#### `/v1/tokenprogram/update` · `api.tokenprogram.update` · SA + U · `registry-programs:manage`
Payload (open): `programId*` plus optional fields.

### 5.10 Registry: chains, wallets, adapters

| Path | Api id | Auth | Scope | Payload |
|---|---|---|---|---|
| `/v1/registry/chains/register` | api.registry.chains.register | SA + U | registry-chains:create | `networkId*` (CAIP-2), `name*`, `chainFamily*` (`evm`\|`solana`), `isTestnet?`, `metadata?` |
| `/v1/registry/chains/update` | api.registry.chains.update | SA + U | registry-chains:manage | `networkId*` plus `name`, `chainFamily`, `isTestnet`, `status` (`ACTIVE`\|`INACTIVE`\|`DEPRECATED`), `metadata` |
| `/v1/registry/chains/get` | api.registry.chains.get | SA | registry-chains:view | `networkId*` |
| `/v1/registry/chains/search` | api.registry.chains.search | SA | registry-chains:view | `filters`, `pagination`, `sortBy` → `{chains:[...]}` |
| `/v1/registry/wallets/register` | api.registry.wallets.register | SA + U | registry-wallets:create | `name*`, `rdns*` (EIP-6963), `supportedChains?[]`, `metadata?` |
| `/v1/registry/wallets/update` | api.registry.wallets.update | SA + U | registry-wallets:manage | `rdns*` plus `name`, `status` (`ACTIVE`\|`INACTIVE`\|`BLOCKED`), `supportedChains`, `metadata` |
| `/v1/registry/wallets/get` | api.registry.wallets.get | SA | registry-wallets:view | `rdns*` |
| `/v1/registry/wallets/search` | api.registry.wallets.search | SA | registry-wallets:view | → `{walletProviders:[...]}` |
| `/v1/adapter/register` | api.adapter.register | SA + U | registry-adapters:create | `adapterId*`, `name*`, `chainIds*[]`, `config*{}`, `type?`, `priority?`, `active?` |
| `/v1/adapter/update` | api.adapter.update | SA + U | registry-adapters:manage | `adapterId*` plus optional fields |
| `/v1/adapter/get` | api.adapter.get | SA | registry-adapters:view | `adapterId*` |
| `/v1/adapter/search` | api.adapter.search | SA | registry-adapters:view | → `{adapters:[...]}` |

Integrators normally only **read** these (chains and wallets for proxy tokens). Registration is platform-operated.

```json
{"context":{"id":"api.registry.chains.search","version":"1.0","ts":"...","msgId":"<uuid>","developerToken":"<DEV>","authorization":"Bearer <JWT>"},
 "payload":{"filters":{"status":"ACTIVE","isTestnet":true},"pagination":{"limit":50,"offset":0},"sortBy":{"field":"name","order":"asc"}}}
```
→ `{"response":{"chains":[{"id":"<uuid>","networkId":"eip155:84532","name":"Base Sepolia","chainFamily":"evm","isTestnet":true,"status":"ACTIVE","metadata":{"nativeCurrency":{"name":"Ether","symbol":"ETH","decimals":18},"explorers":[...],"blockTime":2},"identities":[],"createdAt":"...","updatedAt":"..."}],"pagination":{...}}}`

Operator-only registry routes:
- `/v1/registry/capability/publish` (`internal:manage`, protected): republishes the instance capability document.
- `/v1/registry/lookup-address` (`internal:view`): its schema needs `{chain_id, address}`, but the code reads `chainId`, so the chain id is always empty (a bug).
- GET `/v1/registry/forwarding/:did` and GET `/v1/instance/capabilities`: GETs, so always 401.

### 5.11 Clients (developer credentials)

All need SA plus a user JWT. The full workflow is in `auth-and-onboarding.md` §3.

| Path | Api id | Scope | Payload (closed) | Response |
|---|---|---|---|---|
| `/v1/clients/register` | api.clients.register | clients:create + **super** | `name*` (1–255), `description?` (up to 1000), `scopes?[]`, `allowedOperations?{scope:{dotPath:[values]}}`, `identities?` (at most 1, `[{type:"owner",address:"<plaintext>"}]`) | `{clientId, keycloakClientId, clientSecret, developerToken, name, status, creator{accountId,address}, owner{accountId,address}, scopes[{scope,status,...}], createdAt}`. The secret appears **once**. |
| `/v1/clients/get` | api.clients.get | clients:view | `clientId*` (uuid) | ClientProfile `{id, name, description, scopes[ScopeEntry], allowedOperations, identities, status, isSuperAdmin, keycloakClientId, creator{address}, createdAt, updatedAt}` |
| `/v1/clients/list` | api.clients.list | clients:view | `{}` | `{clients:[ClientProfile]}` |
| `/v1/clients/update` | api.clients.update | clients:manage | `clientId*`, `name?`, `description?` | ClientProfile |
| `/v1/clients/deactivate` | api.clients.deactivate | clients:manage | `clientId*` | ClientProfile (credentials invalid within the cache TTL) |
| `/v1/clients/reactivate` | api.clients.reactivate | unmapped, so **super** | `clientId*` | ClientProfile |
| `/v1/clients/rotate-secret` | api.clients.rotate_secret | unmapped, so **super** | `clientId*`, `graceSeconds?` (≥0; clamped; 0 or omitted revokes immediately) | `{clientId, keycloakClientId, clientSecret, developerToken, oldSecretValidUntil?, rotatedAt}` |
| `/v1/clients/scopes/update` | api.clients.scopes.update | unmapped, so **super** | `clientId*`, `scopes*[]` (replace) | ClientProfile |

ScopeEntry fields (snake_case): `scope`, `status` (`active`\|`pending`\|`rejected`), `requested_by`, `requested_by_name`, `requested_at`, `approved_by`, `approved_by_name`, `approved_at`, `rejected_by`, `rejected_by_name`, `rejected_at`, `reason`, `workflow_id`, `expires_at`.

```json
{"context":{"id":"api.clients.rotate_secret","version":"1.0","ts":"...","msgId":"<uuid>","developerToken":"<DEV>","authorization":"Bearer <JWT>"},
 "payload":{"clientId":"0199c0de-1111-7aaa-8bbb-123456789abc","graceSeconds":3600}}
```
→ `{"response":{"clientId":"0199c0de-...","keycloakClientId":"sa-0199c0de-...","clientSecret":"<new, once>","developerToken":"c2Et...","oldSecretValidUntil":"2026-10-03T11:00:00Z","rotatedAt":"2026-10-03T10:00:00Z"}}`

Errors: 403 "client registration currently requires a superadmin service account (interim governance)…", 404 (not found, or not yours), 409 (registry-side per-account limits), 500 `SCOPE_MAPPING_NOT_CONFIGURED` (unmapped routes for a non-superadmin).

### 5.12 Scopes, approvals, user scopes

| Path | Api id | Auth | Scope | Payload | Response |
|---|---|---|---|---|---|
| `/v1/scopes/search` | api.scopes.search | SA (+U) | scopes:view | `{filters?, pagination?, sortBy?}` | `{scopes:[{id, entity, scope, accessLevel, createdAt}], pagination}` |
| `/v1/scopes/apis/search` | api.scopes.apis.search | SA (+U) | scopes:view | same | `{scopeApis:[{id, scopeKey, apiId, createdAt}], pagination}` |
| `/v1/scope-approvals/` (trailing slash) | api.scope-approvals.list | SA + U | clients:manage | `{status?: pending\|active\|rejected (default pending), clientId?}` | `{clients:[{clientId, clientName, status, scopes:[{scope, requestedBy, requestedByName, requestedAt, expiresAt}]}]}` |
| `/v1/users/scopes/get` | api.users.scopes.get | SA (+U) | unmapped, so **super** | `{account:{accountId\|address}}` (exactly one) | `{accountId, scopes[]}` |
| `/v1/users/scopes/update` | api.users.scopes.update | SA (+U) | unmapped, so **super** | `{account:{accountId\|address}, scopes*[]}` (replace; protected scopes need a superadmin; removals force a logout) | `{accountId, scopes[]}` |

```json
{"context":{"id":"api.scopes.apis.search","version":"1.0","ts":"...","msgId":"<uuid>","developerToken":"<DEV>"},
 "payload":{"filters":{"apiId":"api.token.transact"},"pagination":{"limit":10,"offset":0}}}
```
→ `{"response":{"scopeApis":[{"id":"<uuid>","scopeKey":"tokens:transact","apiId":"api.token.transact","createdAt":"..."}],"pagination":{...}}}`

Approve or reject a protected scope through `/v1/workflows/execute` with workflow `scope-approval`, action `reviewed` (§5.15).

### 5.13 Delegations

Create, approve and revoke go through `/v1/workflows/execute` (§5.15). See `auth-and-onboarding.md` §9 for semantics.

#### `/v1/delegations/list` · `api.delegations.list` · SA + U · `delegations:view`
Payload (closed): `filter*` ∈ `granted_by_me | granted_to_me | pending`.
```json
{"context":{"id":"api.delegations.list","version":"1.0","ts":"...","msgId":"<uuid>","developerToken":"<DEV>","authorization":"Bearer <JWT>"},"payload":{"filter":"granted_to_me"}}
```
→ `{"response":{"filter":"granted_to_me","count":1,"delegations":[{"id","grantorAddress","granteeAddress","label","permission","ruleType","status","expiresAt","requestedBy","approvedAt","revokedAt","createdAt"}]}}`. Addresses are hashes.

#### `/v1/delegations/check` · `api.delegations.check` · SA + U · `delegations:view`
Payload (closed): `tokenId*` (uuid). → `{"response":{"tokenId","permissions":{"view":{"allowed":true,"source":"owner"},"transact":{"allowed":true,"source":"delegation","delegationId":"<uuid>","labelMatch":"tokens:id:..."},"manage":{"allowed":false,"source":"none"}},"denyRules":[{"delegationId","label","permission"}]}}`.

### 5.14 Terms

| Path | Api id | Auth | Scope | Payload | Response |
|---|---|---|---|---|---|
| `/v1/terms/get` | api.terms.get | SA (no user needed) | terms:view | `{docType?}` (`terms_of_use` default \| `privacy_notice`) | `{id, docType, version, versionLabel, content, contentFormat:"markdown", contentHash:"sha256:<hex>", status:"published", requiresReconsent, effectiveFrom, publishedAt}` |
| `/v1/terms/accept` | api.terms.accept | SA + U | terms:create | `{versionId*, docType?}` | `{docType, version, consentedAt, message:"Consent recorded."}`. 409 if a newer version is live. |
| `/v1/terms/publish` | api.terms.publish | SA | terms:manage (**protected**) | `{content*, docType?, versionLabel?, requiresReconsent? (default true), effectiveFrom?}` | 201 TermsVersion (version auto-increments) |

```json
{"context":{"id":"api.terms.get","version":"1.0","ts":"...","msgId":"<uuid>","developerToken":"<DEV>"},"payload":{"docType":"terms_of_use"}}
```

### 5.15 Workflows

#### `/v1/workflows/execute` · `api.workflow.execute` · SA + U + C · `workflows:create`
Payload (closed): `workflow*`, `action*`, `data*` (validated against the registered schema of the workflow and action). The server injects `workflowId`, the user JWT and the initiator client id. The first step returns **202** `{"workflowId":"<workflow>-<uuid>","status":"accepted"}` (or a handler-specific body). Later steps need `data.workflowId` and return 200 (`{workflowId, action, status:"signaled"}` by default).

| workflow | actions | `data` |
|---|---|---|
| `delegation-create` | `allow`, `deny` | `grantee_address*` (plaintext), `label*`, `permission*` (`view`\|`transact`\|`manage`), `expires_at?` (allow only), `allowedOperations?` (must include `<entity>:<permission>`) |
| | `approve`, `reject` (owner), `cancel` (requester) | `delegation_id*` (uuid) |
| `delegation-revoke` | `revoke` (grantor only, status `active`) | `delegation_id*` |
| `profile-update` | `initiate` (`name`\|`email`\|`mobile`), `verify_current_ownership`, `verify_new_email`, `verify_new_mobile` (`workflowId*`, `otp*`, `recipient*`) | Prefer `/v1/account/update` |
| `scope-approval` | `reviewed` (superadmin) | `clientId*`, `scopes*[{scope*, status* approved\|rejected, reason?}]` |
| | `cancel` (requester) | `clientId*`, `scopes?[]` |

```json
{"context":{"id":"api.workflow.execute","version":"1.0","ts":"...","msgId":"<uuid>","developerToken":"<DEV>","authorization":"Bearer <owner JWT>"},
 "payload":{"workflow":"delegation-create","action":"allow",
            "data":{"grantee_address":"bob-acme","label":"tokens:tokenclass:ACME-PTS","permission":"view","expires_at":"2026-12-31T23:59:59Z"}}}
```
→ 202 `{"context":{"status":"accepted",...},"response":{"delegation_id":"0199d0d0-...","status":"pending"}}`. On the owner path the delegation activates asynchronously. On the non-owner path the response adds `delegation_ids` and `owners`, and each owner must approve.

Errors: 404 "workflow not found: <name>", 400 (schema or action), 403 (scope, consent, "only grantor can revoke"), 409 (duplicate delegation).

#### `/v1/workflows/status` · `api.workflow.status` · SA + U · `workflows:view`
Payload: `{workflowId*}` → the raw runtime status (workflow-defined), for example `{"workflowId":"profile-update-...","state":"running","currentStep":"verify_current_ownership"}`.

#### `/v1/workflows/cancel` · `api.workflow.cancel` · SA + U + C · `workflows:manage`
Payload: `{workflowId*, workflowName*}` → `{"workflowId":"...","status":"cancelled"}`.

### 5.16 Internal / peer: **not for integrators**

| Path | Api id | Auth | Purpose |
|---|---|---|---|
| `/v1/internal/workflows/register` | api.internal.workflow.register | SA `internal:create` | units-workflows self-registration |
| `/v1/internal/identities/cache-evict` | api.internal.identities.cache_evict | SA (unmapped) | cache eviction |
| `/v1/internal/delegation/reconcile` | api.internal.delegation.reconcile | SA (unmapped) | delegation identity stamping |
| `/v1/internal/transactions/destination-status` | api.internal.transactions.destination_status | SA `internal:view` | federation |
| `/v1/internal/transactions/lifecycle-update` | api.internal.transactions.lifecycle_update | SA `internal:create` | workflow writes status_v2 |
| `/v1/internal/workflow-ops/record` | api.internal.workflow_ops.record | SA `internal:create` | workflow op audit |
| `/v1/internal/primitives/complete` | api.internal.primitives.complete | signed body (engine or peer) | engine callback |
| `/v1/internal/primitives/status` | api.internal.primitives.status | SA `internal:view` | peer instance query |
| GET `/v1/internal/primitives/:txn_id/:op_seq` | legacy | always 401 | — |
| `/v1/ulip/{Lock,CreateIncoming,CommitDebit,CommitCredit,Unlock,RejectIncoming,Credit,Debit,RecordProxyEntry,Reconcile,DomainLifecycle,Mint,Burn,Freeze,Unfreeze,Update,PruneTokenTransactions}` | api.ulip.* | ULIP envelope signature (instance keys) | instance-to-instance primitives |
| `/v1/registry/capability/publish` | api.registry.capability.publish | SA `internal:manage` (protected) | republish the capability document |

---

## 6. Error code table

All errors arrive in `context.error.{code,message}` with `context.status:"failed"` and `response:{}`.

| HTTP | code | Typical causes (message) | Fix |
|---|---|---|---|
| 400 | `INVALID_INPUT` | JSON-schema failure (the validator text, e.g. additional property, missing field, enum); "Invalid JSON format in request body"; business validation: `recipient address is required for transfer`, `Invalid amount: …`, `operation_not_supported`, `primitive_capability_missing`, `invalid_extension_namespace`, `extension_namespace_not_allowed`, `voucher_transfer_policy_disabled`, `proxy_proof_must_be_confirmed`, `chainId, contractAddress, and walletAddress are required for proxy tokens`, `contractAddress does not match registered contract for X on Y`, `NFT federation transfer amount must be 1`, `federation transfer is not supported by this token program capability`, `token_id_required_for_domain_lifecycle_update`, `account_did_required`, delegation `allowedOperations` shape errors, `no resource owners found for label`, `no eligible owner accounts for this label` | Fix the payload. Send only documented keys. Register a class config. Check that the program supports the operation. |
| 400 | `VALIDATION_FAILED` | Field-level validation | Fix the field |
| 400 | `BAD_REQUEST` | Fiber body errors; `/account/sign` missing `method`, `account_did` or `username` | Fix the body |
| 401 | `UNAUTHORIZED` | "Unauthorized. Developer token is missing or empty"; "invalid developer token"; "Unauthorized. The JWT is missing, invalid, or expired"; the route needs a user but none was given; `otp_invalid`; `refresh_token_invalid`; signature: "signature with keyId and jws is required", "invalid signature key reference", "signature key not found", "signature key is not active", "unsupported signature key type", "invalid signature", "signature key does not belong to the authenticated account"; "otp contact does not match account" | Put the tokens in the body; refresh or re-login; sign correctly |
| 401 | `SESSION_REVOKED` | Refresh-token reuse destroyed the session | Re-login; single-flight refresh |
| 403 | `FORBIDDEN` | "User not authorized: no_matching_allow_rule"; "operation denied by active deny delegation on label '…'"; "user is not authorized to mint tokens for this class"; "not authorized to access this transaction"; "client is not allowed to perform this operation" (allowedOperations); owner mismatch on `/token/add`; "client registration currently requires a superadmin service account (interim governance)"; "only grantor can revoke"; wallet address not registered | Act as an owner, issuer or delegate; poll as the owner; ask the platform team |
| 403 | `CLIENT_INSUFFICIENT_SCOPE` | "service account does not have required scope: <scope>" | Add the scope to the client |
| 403 | `USER_INSUFFICIENT_SCOPE` | User lacks the scope (`enableUserScopeCheck` on) | Fix the user scopes (superadmin) |
| 403 | `OIDC_CLIENT_API_NOT_PERMITTED` | Third-party OIDC session on a non-allowlisted api | Use a first-party session |
| 403 | `TERMS_CONSENT_REQUIRED` | Latest terms not accepted (`enableConsentEnforcement` on) | `/terms/get` then `/terms/accept` |
| 404 | `RESOURCE_NOT_FOUND` | "Token not found", "Token class not found", "Recipient address not found", `recipient_address_not_found`, "Owner address not found", "delegation not found", "workflow not found: x", "Client not found", "Endpoint Not Found" | Check the ids. Use the hash for the `/token/add` owner. |
| 409 | `CONFLICT` | "Token class already exists", "Token program already exists", a config already exists, duplicate proxy import (sessionless), stale terms version, "sender account is homed on another instance", duplicate delegation | Treat it as already done, or re-fetch |
| 409 | `FORWARD` | Login for an account homed on another instance (the message has the home id and API URL) | Call the home instance |
| 409 | `IDENTIFIER_TAKEN` | Address already registered (sign-up) | Choose another address |
| 409 | `RESOURCE_ALREADY_EXISTS` | Defined but rarely used (repositories use CONFLICT) | — |
| 429 | `TOO_MANY_REQUESTS` | "rate limit exceeded" (per tier and scope) with a `Retry-After` header | Back off for `Retry-After` seconds |
| 429 | `EXTERNAL_SERVICE_ERROR` | OTP rate limit | Wait before resending the OTP |
| 500 | `INTERNAL_ERROR` | Generic; "federation service is not configured"; `transact_not_routed`; "failed to send OTP" | Retry with backoff; report it with the msgId and X-Correlation-ID |
| 500 | `INTERNAL_SERVER_ERROR` | Unknown-error fallback | Same |
| 500 | `DATABASE_ERROR` | "Database operation failed" | Retry, then report |
| 500 | `SCOPE_MAPPING_NOT_CONFIGURED` | Api id has no registry scope mapping (rotate-secret, reactivate, clients scopes/update, users/scopes/*) for a non-superadmin SA | Platform team or the web app |
| 501 | `NOT_IMPLEMENTED` | `/account/keys/rotate` | Register a new key and remove the old one |
| 503 | `EXTERNAL_SERVICE_ERROR` | "<svc> service unavailable": registry, Keycloak, Vault, Kafka, OTP; the sandbox outside its hours | Retry later |
| 503 | `AUTHZ_LOOKUP_FAILED` | Transient scope-catalogue lookup failure | Retry |

---

## 7. Asynchronous (polled) error codes

These appear in `/v1/transaction/status` → `response.error` after a 200 or 202 submit.

| code / message | Cause | Fix |
|---|---|---|
| `UNSUPPORTED_TOKEN_STANDARD` | The class `tokenStandard` is not in the program whitelist (an exact match is required) | Re-register the class with a whitelisted standard |
| `INVALID_PAYLOAD: unknown variant …` | Bad identity `type`, or a bad enum in program data | Use the documented enums |
| `Invalid LoanOriginatedPayload: invalid digit found in string` | A decimal in a u128 field | Integer strings only |
| `foir must be in (0, 1], got 0` | Loan `foir` (current code: integer string 1–10000, basis points; message text is misleading) | Send `"1"` |
| `CAPABILITY_DENIED: program 'purpose-bound-voucher' does not support federation primitive 'domain_lifecycle'…` | Voucher mint, issue or redeem on current builds | Not mintable today |
| `FORBIDDEN: User not authorized: no_matching_allow_rule` | Caller is not an identity on the token (often because `identities[]` was sent on mint) | Write as the owner or issuer; omit `identities[]` |
| `RESOURCE_NOT_FOUND: recipient_address_not_found` | Transfer recipient unresolved (live sanctum issue for fungible) | Open platform issue |
| `INSUFFICIENT_BALANCE` | Balance too low for a transfer, burn or lock | Check the balance |
| `min-balance` / `max-supply` hook failures | Class `metadata.minBalance` / `maxSupply` exceeded | Adjust the amount |

---

## 8. Removed / stale endpoints and fields

Older docs, the OpenAPI text, the Postman collection, the units-api CLAUDE.md and the changelog mention the following. **They do not work today.**

| Stale item | Reality / replacement |
|---|---|
| `POST /v1/token/transfer` (federation-interfaces.yaml) | No such route. Use `/v1/token/transact` with `operation:"transfer"`. |
| `/v1/token/burn`, `/token/freeze`, `/token/lock`, `/token/update` endpoints; context ids `api.token.burn` and so on | Everything is a `/v1/token/transact` `operation` with api id `api.token.transact` |
| "Unified Transact endpoint for mint" (changelog 2026.02) | Mint has its own endpoint, `/v1/token/mint` |
| `/v1/api-clients/register`, `/v1/api-clients/keys/create`, `/v1/api-clients/update-scopes`, `/v1/clients/keys/*`, `fnt_…` API keys, 90-day key expiry, `allowedDeveloperTokens` allowlist | Removed. Use `/v1/clients/*`. The credential is the SA secret (`c2Et…`). There is no per-key revocation; deactivate or rotate the client instead. |
| Developer token in the `Authorization: Bearer` header, `X-Developer-Token` header, `X-Finternet-Signature` header, user JWT in the `Authorization` header | Ignored. Both tokens go in the body (`context.developerToken`, `context.authorization`). |
| `context.developerSignature` (RFC 9421) | Dropped. It is accepted by some schemas and ignored. |
| README envelope `signature.key_id` | It is `keyId` |
| `stepUpToken` (OTP step-up on delegation and client mutations) | Removed (PR #284). The closed schemas reject it with 400. |
| `GET /v1/did/:address`, DID document storage | Disabled. Use `POST /v1/address/resolve`. |
| `GET /v1/account/keys`, `GET /v1/registry/forwarding/:did`, `GET /v1/instance/capabilities` | Always 401 under SA auth (no envelope). Use `/v1/account/keys/search`. |
| `/v1/account/lookup` | Not active |
| `/v1/registry/lookup-address` "removed" (spec) | Still routed, but `internal:view` and buggy (chain id ignored) |
| `entityType: "Individual"` / `"individual"` / `"INDIVIDUAL"` | `PERSONAL` \| `BUSINESS` |
| `transactions:view` scope (token spec) | `tokens:view` |
| `tokenClassConfigs:manage` for config register (spec) | `tokenClassConfigs:create` |
| Docs mapping mint/transfer → `tokens:create`, freeze/lock/burn → `tokens:manage`, `delegations:create/manage` | Mint and add → `tokens:create`; **all** transact operations → `tokens:transact`; delegations through `workflows:create` |
| `users:view` / `users:manage` scopes | Not in the catalogue; `/users/scopes/*` is unmapped, so superadmin only |
| `tokens:read` / `tokens:write` (user-scopes spec example) | Not valid scopes |
| `sort` in search payloads | `sortBy` |
| `amount` on transact (burn, transfer) and on the Kafka wire | `value` |
| Proxy `/token/add` field `amount` | `value` |
| Program ids `reference-ft`, `reference-nft`, `reference-credential`, `nfh-voucher`, `loan-nft`, `loan-pool-nft` | `fungible`, `non-fungible`, `credential`, `purpose-bound-voucher`, `loan-nft-program`, `loan-pool-nft-program` |
| Program operations in PascalCase (`Transfer`, `Burn`), standards `FT`/`NFT` (program spec) | lowercase operations; `UNITS-FT`, `UNITS-NFT`, … |
| `identities:[{id:"ALICE_ADDRESS",type:"owner"}]` on mint (quickstart) | Do **not** send identities on mint |
| Quickstart "status `successful` means mint done; tokenId in status response" | Poll for `completed`; get the tokenId from `/transaction/get` `responseData` or by search |
| Mint "requires end-user signature" (token spec) | Not required. Only transact requires one. |
| Mint returns 202 "accepted" (docs) | 200 with `status:"submitted"`. Transact returns 202. |
| `chainDeployments` / `status` in class register examples | Ignored |
| `valueFormat` default "raw" (schema text) | Code default is `display`. Send it explicitly, on the four token endpoints only. |
| `tokenId` "must be `urn:uuid:`" | A bare UUID is fine (urn form also accepted) |
| DID shapes `did:key:z6Mk…`, `did:web:…`, `did:finternet:…`, `did:units:acct:<uuid>`, `did:fi:…` in specs | Live accounts use `did:units:0x<ed25519 pubkey hex>` |
| `preferred_username` = plaintext address (some docs) | It is `sha256(lower(trim(address)))` |
| `jws` as a compact JWS (`eyJhbGciOiJFUzI1NksifQ..sig`, ES256K) | Raw std-base64 Ed25519 signature over JCS(payload); ed25519 keys only |
| `/v1/account/sign` "signs a ULIP envelope (not usable as outer jws)" | It signs JCS(payload). Use `envelope.signature.signature` as `jws` with `response.keyId`. |
| On-chain anchoring of proofs (docs) | Roadmap. Merkle proofs may stay `pending`, and `proof/verify` checks structure. Confirm current data-protection guarantees with Finternet. |
| Webhooks / callbacks for transaction completion | None. Poll. |
| `DEVELOPER_TOKEN=dev_pk_test_token` (seed script), `dev-token-...` placeholder | Obsolete; returns 401 |
| Base URL `https://api.finternetlab.io` (docs examples) | Placeholder. Use the hosts at the top of this file. |
| `/v1/account/refresh` "pending branch" (specs) | Live on units-api |
