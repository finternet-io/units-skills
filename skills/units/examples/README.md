# UNITS examples

Runnable, dependency-light starting points for integrating with UNITS (the federated ledger/token platform of Finternet, a mission of Networks for Humanity).
Snapshot: 2026-10-03. Some behaviour depends on which build your instance runs. Before you rely on these, check your instance with `/v1/tokenclassconfig/get` and `/v1/tokenprogram/search`.

| File | What it is |
|---|---|
| `units-client.ts` | TypeScript client for Node 20+ with no dependencies (uses built-in `fetch` and `node:crypto`). It covers the envelope, `call()`, OTP login and signup, address hashing, JCS + Ed25519 signing, polling, tokenId resolution, idempotent class registration, mint/add/transact, reads, delegations and `SessionManager`. |
| `units_client.py` | The same client for Python 3.10+ (`pip install requests cryptography`). |
| `quickstart.sh` | A first round trip with curl and jq: OTP, then create an account, register a class and its config, mint, poll, read the transaction, search and fetch the proof. |
| `token-classes/*.json` | Ready-to-send `register` and `config` payloads, one file per example class. |

## Prerequisites

| You need | Why | How |
|---|---|---|
| A **developer token** | Identifies your app on every call (`context.developerToken`) | Self-serve in the web portal (`sanctum.finternetlab.io` → **API Access → Register client**; see `../references/portals-and-access.md`), or ask Finternet. It looks like `base64("sa-<uuid>:<secret>")` and is **per environment**. |
| Scopes on that client | Each endpoint checks one | At least `accounts:create`, `accounts:manage`, `accounts:view`, `tokenClasses:create`, `tokenClassConfigs:create`, `tokens:create`, `tokens:transact`, `tokens:view`, `keys:create`, `keys:view` (see `../references/auth-and-onboarding.md` §8) |
| An email or phone you control | OTP login; the account becomes your **operator** (it owns the classes it registers) | Any address. Sandbox OTP is `123456`. |
| Node 20+ | `units-client.ts` (built-in `fetch`, `node:crypto`; run `.ts` with `--experimental-strip-types` on Node 22, or `npx tsx`) | `node -v` |
| Python 3.10+ | `units_client.py` | `pip install requests cryptography` |
| bash, curl, jq, uuidgen/shasum | `quickstart.sh` | Preinstalled on macOS (`brew install jq` if missing) |

## Environment variables

| Variable | Used by | Required | Meaning / default |
|---|---|---|---|
| `UNITS_BASE_URL` | all | ✅ | API base, e.g. `https://units.sanctum.finternetlab.io` (sandbox) or `https://units.finternetlab.io` (prod) |
| `UNITS_DEVELOPER_TOKEN` | all | ✅ | Developer token. **Never commit it, and never ship it to a browser.** |
| `UNITS_EMAIL` | quickstart | ✅ | Email or E.164 phone to log in or sign up as |
| `UNITS_OTP` | quickstart | — | OTP to use. Sandbox accepts `123456`; on production you're prompted. |
| `UNITS_ADDRESS` | quickstart | — | Address for a **new** account (`^[a-z0-9._-]+$`). Default `qs-<8 hex of email hash>` |
| `UNITS_NAME` | quickstart | — | Display name for a new account (letters and spaces only). Default `Quickstart User` |
| `UNITS_TOKEN_CLASS` | quickstart | — | Class to register. Default `QS<8 hex>-PTS`. Names are global, so pick something unique. |
| `OPERATOR_EMAIL` | client snippets below | — | Email of your operator account |

The quickstart never prints the developer token or JWTs.

## Run the quickstart (sandbox)

```bash
export UNITS_BASE_URL=https://units.sanctum.finternetlab.io
export UNITS_DEVELOPER_TOKEN='<from Finternet; never commit>'
export UNITS_EMAIL=you@yourcompany.com
./quickstart.sh
```

- On non-production instances the sandbox OTP is fixed at `123456`, but `send OTP` may still deliver a real email or SMS.
- On production (`units.finternetlab.io`) the script asks you for the real OTP.
- The sandbox is available roughly 08:00–21:00 IST on weekdays. If you get connection errors outside those hours, the instance is probably off.
- Token class names are global across all tenants. By default the quickstart uses `QS<8hex>-PTS`, derived from your email. Set `UNITS_TOKEN_CLASS` to choose your own name.

## Use the clients

```ts
import { UnitsClient, Ed25519Signer, hashAddress } from "./units-client.ts";
import pts from "./token-classes/acme-pts.fungible.json" with { type: "json" };

const units = new UnitsClient({ baseUrl: process.env.UNITS_BASE_URL!, developerToken: process.env.UNITS_DEVELOPER_TOKEN! });
const { session } = await units.loginOrSignup(process.env.OPERATOR_EMAIL!, async () => "123456");
await units.ensureTokenClass(pts, session.accessToken);                   // class + config, idempotent
const sub = await units.mint(session.accessToken, { tokenClass: "ACME-PTS", initialSupply: "100000" }, { valueFormat: "raw" });
const done = await units.awaitCompletion(sub, session.accessToken, { tokenClass: "ACME-PTS" });
console.log(done.tokenId);

// transact (signed): register an Ed25519 key once per account, then sign every transact payload
const signer = Ed25519Signer.generate();
const key = await units.registerSigningKey(session.accessToken, signer.publicKeyHex());
await units.transact(session.accessToken, { operation: "burn", tokenId: done.tokenId!, value: "2500", reason: "redeemed" },
                     { signer: signer.withKeyId(key.id), valueFormat: "raw" });
```

```python
from units_client import UnitsClient, Ed25519Signer
import json, os
units = UnitsClient(os.environ["UNITS_BASE_URL"], os.environ["UNITS_DEVELOPER_TOKEN"])
s = units.login_or_signup(os.environ["OPERATOR_EMAIL"], lambda: "123456")["session"]
units.ensure_token_class(json.load(open("token-classes/acme-pts.fungible.json")), s["accessToken"])
```

Offline self-tests, which make no network calls: `node units-client.ts selftest` and `python3 units_client.py selftest`. Both clients produce byte-identical JCS output and Ed25519 signatures for the same seed.

## Client API reference

Both clients expose the same operations; Python uses snake_case. Every method builds the envelope (`context.id`, `version`, `ts`, a fresh `msgId`, `developerToken`, `authorization`), sends `POST`, and returns `response` or raises `UnitsApiError` with `code`, `message` and HTTP status.

| TypeScript (`UnitsClient`) | Python (`UnitsClient`) | Endpoint(s) | Notes |
|---|---|---|---|
| `buildEnvelope(path, payload, opts)` | `build_envelope(...)` | — | Adds `valueFormat` only for token get/search/mint/transact (`VALUE_FORMAT_PATHS`) |
| `call(path, payload, opts)` | `call(...)` / `call_or_raise(...)` | any | Low level. `ok` = 2xx **and** `context.status != "failed"`. Honours `429 Retry-After` for reads. |
| `sendOtp(username)` | `send_otp` | `/v1/account/login` | Step 1 of login |
| `verifyOtp(username, otp)` | `verify_otp` | `/v1/account/login` | Returns `isExisting`. If false, the token is an OTP JWT for signup only. |
| `createAccount(otpJwt, {address, name, entityType})` | `create_account(otp_jwt, address, name, entity_type)` | `/v1/account/create` | `entityType`: `PERSONAL` \| `BUSINESS` |
| `loginOrSignup(username, getOtp, signup?)` | `login_or_signup` | login (+create) | Returns `{session, created, address?, addressHash}`. **Store the address and hash** (address is only known at signup). |
| `refresh(refreshToken)` | `refresh` | `/v1/account/refresh` | Refresh tokens are single-use; reuse gives `SESSION_REVOKED` |
| `getAccount(session)` | `get_account` | `/v1/account/get` | Address and email come back **masked** |
| `registerSigningKey(session, pubHex)` | `register_signing_key` | `/v1/account/keys/register` | Returns `id`, which you use as the `keyId` for transact signatures |
| `ensureTokenClass(def, operatorSession)` | `ensure_token_class` | tokenclass get/register + tokenclassconfig get/register | Idempotent; fills `tokenClassId` |
| `mint(session, payload, {valueFormat})` | `mint` | `/v1/token/mint` | Throws if `identities` is present |
| `addCredential(payload)` | `add_credential` | `/v1/token/add` | Dev token only; `owner` = address **hash** |
| `addProxy(session, payload)` | `add_proxy` | `/v1/token/add` | `chainId`, `contractAddress`, `walletAddress`, `value` |
| `transact(session, payload, {signer, valueFormat})` | `transact` | `/v1/token/transact` | Signs JCS(payload) when a signer is given; rejects `amount` |
| `pollTransaction(session, txId, opts)` | `poll_transaction` | `/v1/transaction/status` | Backoff until `completed`/`failed`/`cancelled`; poll with the **owner/initiator** session |
| `resolveTokenId(session, txId, {tokenClass})` | `resolve_token_id` | `transaction/get` → `token/search` | Order: `metadata.token_id` → `affectedTokenIds[0]` → `responseData` → newest of class |
| `awaitCompletion(submit, session, opts)` | `await_completion` | poll + resolve | Use after every write |
| `getToken`, `searchTokens`, `tokenTransactions` | `get_token`, `search_tokens`, `token_transactions` | `/v1/token/get|search|transactions` | Reads (ownership-scoped) |
| `getTransaction`, `getProof` | `get_transaction`, `get_proof` | `/v1/transaction/get`, `/v1/transaction/proof` | Proofs often `pending` (batching) |
| `grantDelegation`, `revokeDelegation`, `listDelegations`, `checkDelegation` | same, snake_case | `/v1/workflows/execute` (`delegation-create` / `delegation-revoke`), `/v1/delegations/list|check` | Consent / third-party access |

Helpers: `hashAddress`, `preferredUsernameFromJwt`, `decodeJwtPayload`, `isValidUnitsAddress`, `canonicalize` (RFC 8785 JCS), `Ed25519Signer` (`generate`, `fromSeedHex`, `withKeyId`, `publicKeyHex`, `signPayload`), and `SessionManager` (refreshes on a timer under 30 minutes with a single-flight lock: `start()`, `accessToken()`, `stop()`).

## Token class files

Every file has the shape `{ "_about": "...", "register": {...}, "config": {...} }`. Only `register` and `config` are sent. `config.tokenClassId` is filled in automatically from the register response (`response.id`). **Rename the `ACME-` prefix before you use them.**

| File | Class | tokenStandard | programId | Created with | Status (2026-10) |
|---|---|---|---|---|---|
| `acme-pts.fungible.json` | ACME-PTS | UNITS-FT | `fungible` | `/token/mint` | Works. Transfers to other users failed on sanctum (`recipient_address_not_found`). |
| `acme-kyc.credential.json` | ACME-KYC | UNITS-CREDENTIAL | `credential` | `/token/add` (credential) | Works and was verified live. |
| `acme-loan.loan-nft.json` | ACME-LOAN | UNITS-Loan | `loan-nft-program` | `/token/mint` (= `loan_originated`) | Works and was verified live. |
| `acme-asset.non-fungible.json` | ACME-ASSET | UNITS-NFT | `non-fungible` | `/token/mint` | Depends on the environment: it is in the code but was not discoverable on sanctum in Aug 2026. Check `/v1/tokenprogram/search` on your instance first. |
| `acme-usdc.proxy.json` | ACME-USDC | PROXY-FT | `stables` | `/token/add` (proxy) | The code path exists. Usually you can just use the seeded `USDC` class. |
| `acme-pool.loan-pool.json` | ACME-POOL | UNITS-LoanPool | `loan-pool-nft-program` | `/token/mint` (snake_case data) | In the code, but not exercised live. |
| `acme-voucher.purpose-bound.json` | ACME-VOUCHER | UNITS-SFT | `purpose-bound-voucher` | `/token/mint` | **Blocked**: mint fails with `CAPABILITY_DENIED` on current builds. |

## Rules these examples follow (do not "fix" them)

- The developer token and user JWT go **inside the JSON body** (`context.developerToken`, `context.authorization`). UNITS does not read an `Authorization` header.
- Every write is asynchronous. A `submitted` response is not success: poll `/v1/transaction/status` until the transaction reaches `completed`, `failed` or `cancelled`. Many validation errors only show up at that point.
- Never send `identities[]` on mint. Set `valueFormat` explicitly, but only on token get, search, mint and transact. Other endpoints, including `token/add`, reject it with 400, and the clients drop it there automatically. Generic amounts use the field `value`, not `amount`.
- Loan domain operations use `data.value` in current code, for example `loan_disbursed` and `payment_received`. Older builds used `data.amount`. If the instance rejects one with a missing or unknown field error, try the other.
- For a sessionless `/token/add` credential, poll and read with the **owner's** session. The operator session gets `FORBIDDEN`.
- Retry only reads automatically. UNITS has no idempotency key, so blind write retries can create duplicate mints. Deduplicate on your own business IDs, for example by searching with `filters: {"data.loanRefId": "..."}` before you resubmit.
- No secrets live in these files. Keep `.env` files out of git.

## Troubleshooting the examples

| Symptom | Likely cause | Fix |
|---|---|---|
| `curl: (7) Failed to connect` / timeouts on sanctum | Staging is scheduled off (outside ~08:00–21:00 IST weekdays) | Retry in hours, or use local (`../references/local-development.md`) |
| `401 Unauthorized. Developer token is missing or empty` | `UNITS_DEVELOPER_TOKEN` unset, or sent as a header | Export it; the clients put it in `context.developerToken` |
| `401 invalid developer token` | Wrong environment's token (tokens are per environment), rotated or revoked | Get a token for this environment from Finternet |
| `403 CLIENT_INSUFFICIENT_SCOPE` | Client lacks a scope | Ask Finternet to add it (see Prerequisites) |
| `400 INVALID_INPUT` on `account/create` | `entityType` not `PERSONAL`/`BUSINESS`, digits in name, bad address chars | Fix the inputs |
| `409 CONFLICT` "Token class already exists" | Name taken by another tenant | Choose a unique `UNITS_TOKEN_CLASS` |
| Poll shows `failed` with `UNSUPPORTED_TOKEN_STANDARD` | `tokenStandard` not whitelisted for the program | Use the standard from the table above |
| `INVALID_INPUT: primitive_capability_missing` | Config not registered | Run `ensureTokenClass` / step 2 |
| Poll returns `FORBIDDEN` on a `token/add` tx | Polling with the operator session | Poll with the credential **owner's** session |
| Transact `401 signature with keyId and jws is required` | Instance enforces signatures | Register a key and pass a `signer` (see "Use the clients") |
| `node units-client.ts` fails with `Unknown file extension ".ts"` | Node < 22.6 without type stripping | `node --experimental-strip-types units-client.ts selftest` or `npx tsx units-client.ts selftest` |
| `ModuleNotFoundError: cryptography` | Python deps missing | `pip install requests cryptography` |

More causes and fixes are in `../references/troubleshooting.md`.
