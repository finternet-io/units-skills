# UNITS troubleshooting

Snapshot: 2026-10-03. When sources disagree, this file follows this order: behaviour seen live on sanctum (Aug 2026), then current code (units-api / token-runtime HEAD), then specs/OpenAPI, then the public docs (docs.finternetlab.io), then older plan docs. Where live behaviour and code differ, the row says **environment-dependent**. Before you rely on any program id, standard or field name, check it against the live instance with `/v1/tokenclassconfig/get`, `/v1/tokenprogram/search` and `/v1/tokenclass/get`.

Related: [api-reference.md](api-reference.md) · [auth-and-onboarding.md](auth-and-onboarding.md) · [token-programs.md](token-programs.md) · [integration-playbook.md](integration-playbook.md) · [known-gaps.md](known-gaps.md) · [faq.md](faq.md)

---

## 0. How to read a UNITS error

Every response uses the envelope format:

```json
{ "context": { "id": "...", "msgId": "<echo>", "status": "successful|accepted|failed",
               "transactionId": "<txId for async writes>",
               "error": { "code": "INVALID_INPUT", "message": "..." } },
  "response": { } }
```

- A call succeeded only if the HTTP status is 2xx **and** `context.status != "failed"`. Data is in `response`, never in `payload`.
- The client only sees `error.code` and `error.message`. Metadata such as the FORWARD `api_url`, `program_id` and `capability_gate` is written to server logs only. When you report a bug, include the `msgId` and `X-Correlation-ID`.
- **Writes are asynchronous.** `/v1/token/mint`, `/v1/token/add` (both HTTP 200) and `/v1/token/transact` (HTTP 202) only mean the request was accepted. Their response is `{txId, status:"submitted", ...}`. Most business validation runs later in the Rust engine, so the error only shows up when you poll `POST /v1/transaction/status {txId}`, in `response.error {code, message}`.
- So an error can show up in three places:
  1. **Sync**: the HTTP call itself fails (section A).
  2. **Async**: the call returned `submitted`, and polling later returns `status:"failed"` (section B).
  3. **Silent**: nothing fails, but the result is wrong (section C).
- Request validation order: SA auth, SA scope, rate limit, user JWT, user scope (flagged), consent (flagged), signature (required on transact; verified on any route if one is sent), then JSON Schema. A malformed request with bad credentials therefore returns 401/403 before it returns 400.

---

## A. Synchronous HTTP errors (returned by the call itself)

### A.1 400: request shape and business pre-checks

| Symptom (`code: message`) | Cause | Fix |
|---|---|---|
| `INVALID_INPUT` + JSON-schema text mentioning an unknown property in `context` | `context` is `additionalProperties:false`. Any extra key (for example `apiKey`, `username`, `otp`, `stepUpToken`, `developerSignature` when a schema rejects it) is refused. | Send only `id, version, ts, msgId, developerToken, authorization?, valueFormat?, transactionId?, debug?`. |
| `INVALID_INPUT` mentioning a missing `id`/`version`/`ts`/`msgId` | Required context fields are missing. | Add all four. `ts` is RFC 3339. `msgId` is a fresh UUID on every attempt. `version` is `"1.0"` (`"v1"` is also accepted live). |
| `INVALID_INPUT: Invalid JSON format in request body` | Body is not valid JSON, or `Content-Type` is missing. | Send `Content-Type: application/json`. |
| `INVALID_INPUT` naming an unsupported property `amount` on transact | Generic operations use `value`, not `amount`. The schema description also contradicts itself on this. | Use `"value": "<string>"`. Domain operations take their own fields inside `data`. Loan ops (`loan_disbursed`, `payment_received` …) use `data.value` in current code (refactor #220). Older builds (e.g. sanctum Aug 2026) used `data.amount`. |
| `INVALID_INPUT` on `/account/create` with `entityType` | The value was `"Individual"`/`"individual"`, which are stale doc and Postman values. | Use `"PERSONAL"` or `"BUSINESS"`. |
| `INVALID_INPUT` on `/account/create` with `name` / `address` | `name` must be letters and spaces only (`^[\p{L} ]+$`). `address` must match `^[a-z0-9._-]+$` (≤255 chars). | Remove digits and punctuation from `name`. Lowercase `address`. |
| `INVALID_INPUT: primitive_capability_missing` (sync on transact; it can also show up async) | The class has no **token class config**, so it is not bound to a program. A second cause is that the engine has not self-registered its programs, so the instance capability document lacks the program. | Call `POST /v1/tokenclassconfig/register {tokenClass, tokenClassId, programId, preHooks:[]}`, then confirm with `/v1/tokenclassconfig/get`. If the config exists, ask the operator to check engine boot / capability publish. |
| `INVALID_INPUT: operation_not_supported` | The bound program does not list this operation. Examples: `transfer` on credential, `burn` on loan, `mint` on credential (use `/token/add`), `redeem` on fungible. | Check `/v1/tokenprogram/search` for the program's `supportedOperations` (the engine-registered list is authoritative). See [token-programs.md](token-programs.md). |
| `INVALID_INPUT: federation transfer is not supported by this token program capability` | You called `transfer` on CREDENTIAL (`UNITS-CREDENTIAL`), LOAN-NFT (`UNITS-Loan`) or LOAN-POOL (`UNITS-LoanPool`). | These are non-transferable by design. For a loan sale, model the change of ownership with domain operations, or ask for a program. |
| `INVALID_INPUT: recipient address is required for transfer` | `to` is missing. | Set `to` to the recipient's **plaintext** address (for example `"bob"`), not the hash or the DID. |
| `INVALID_INPUT: NFT federation transfer amount must be 1` | NFT transfer with `value` ≠ `"1"`. | Send `"value":"1"`. |
| `INVALID_INPUT: voucher_transfer_policy_disabled` | Voucher (`UNITS-SFT`) transfer, but the class has `metadata.transferable:false` or the config has `voucherTransfer.enabled:false`. The seeded SODEXO-MV has both. | Use your own class with both enabled. Voucher mint is blocked anyway (see B). |
| `INVALID_INPUT: proxy_proof_must_be_confirmed` | PROXY-FT transfer sent without `data.proxyProof` that has `confirmed:true` or a status in confirmed/success/succeeded/finalized. | Execute the on-chain transfer first, then send `data.chainId`, `data.txHash`, `data.proxyProof`. |
| `INVALID_INPUT: chainId, contractAddress, and walletAddress are required for proxy tokens` | Incomplete proxy `/token/add`. | Send all three fields plus `value` (base units). |
| `INVALID_INPUT: contractAddress does not match registered contract for X on Y` | `contractAddress` ≠ class `metadata.contractIds[chainId]`. | Fix the address, or register a class whose `contractIds` includes this chain. |
| `INVALID_INPUT: Invalid amount: ...` | Amount sent as a JSON number, negative, empty, or (for raw) containing a decimal point. | Send amounts as strings. With `valueFormat:"raw"` use integers only. |
| `INVALID_INPUT: invalid_extension_namespace` / `extension_namespace_not_allowed` | `extensions` key is not the class's own program id, or contains bad characters. | Use `extensions: {"<programId>": {...}}` with only `[A-Za-z0-9._-]`. |
| `INVALID_INPUT: token_id_required_for_domain_lifecycle_update` | Non-create operation sent without `tokenId`. | Resolve the tokenId first (see B / FAQ). |
| `INVALID_INPUT: account_did_required` | The caller's account has no DID. This happens with odd SA-only calls. | Call with a user session JWT. |
| `BAD_REQUEST` on `/account/sign` | Malformed two-phase sign request. | See [auth-and-onboarding.md](auth-and-onboarding.md) for the signing flow. |
| `VALIDATION_FAILED` | Field-level validation. | Read the message and fix the field. |

### A.2 401: authentication

| Symptom | Cause | Fix |
|---|---|---|
| `UNAUTHORIZED: Unauthorized. Developer token is missing or empty` | `context.developerToken` is missing. You may have put it in an `Authorization:` header, which is **not read**. | Put the token in the body: `context.developerToken = base64("sa-<client-uuid>:<secret>")`. |
| `UNAUTHORIZED: invalid developer token` | Malformed token (old `fnt_...`/`dev_pk_test_token` formats), revoked or rotated secret, deactivated client, or client without an owner. | Re-check the format (it starts with `c2Et`). After `/v1/clients/rotate-secret`, switch to the new token before `graceSeconds` runs out. |
| `UNAUTHORIZED: Unauthorized. The JWT is missing, invalid, or expired` | `context.authorization` is missing or expired, or is not prefixed with `Bearer `. The controller requires a user session for this endpoint. | Re-login or refresh. Format: `"authorization": "Bearer <jwt>"`. Most token/account endpoints require a session. Only the login calls, `/account/refresh` and sessionless `/token/add` do not. |
| 401 on **every GET** endpoint (`GET /v1/account/keys`, `GET /v1/instance/capabilities`, `GET /v1/registry/forwarding/:did`) | GET requests have no envelope, so the SA token cannot be delivered. | Use the POST equivalents (`/v1/account/keys/search`, etc.). Only `GET /v1/health` and `/.well-known/*` work. |
| `UNAUTHORIZED: signature with keyId and jws is required` | `/v1/token/transact` called without a top-level `signature` on an environment that enforces transact signatures. Enforcement is **environment-dependent**, so always build signing in. | Sign: `jws` = std-base64 **raw Ed25519 signature** over the RFC 8785 JCS bytes of `payload`. `keyId` = an active ed25519 key of the session account. See [auth-and-onboarding.md](auth-and-onboarding.md). |
| `UNAUTHORIZED: invalid signature` | You signed something other than JCS(payload): pretty-printed JSON, the whole envelope, a compact JWS, base64url instead of std base64, or the payload changed after signing. | Canonicalise with JCS, sign the bytes, and std-base64 encode the 64-byte signature. Send exactly the payload you signed. |
| `UNAUTHORIZED: signature key not found` / `signature key is not active` | Wrong `keyId`, or the key was superseded or revoked. | Use `/v1/account/keys/search` to list active ed25519 keys. Register one with `/v1/account/keys/register`. (`/v1/account/keys/create` only returns the custodial Vault key, whose private half you can't use to sign; it works only through `/v1/account/sign`.) |
| `UNAUTHORIZED: signature key does not belong to the authenticated account` | Key belongs to another user, or to the SA owner instead of the session user. | Sign with the key of the account in `context.authorization`. |
| `UNAUTHORIZED` / `otp_invalid` on login | Wrong or expired OTP. | Request a new OTP. Fixed OTP `123456` works on non-prod only. |
| `SESSION_REVOKED` (401) on `/account/refresh` | A refresh token was reused. Refresh tokens are single-use, so the reuse destroyed the whole session. The usual cause is two concurrent refreshes. | Re-login with OTP. Refresh on a timer under 30 minutes, behind a single-flight lock. |
| Generic 401 `refresh_token_invalid` on refresh | Refresh token expired: idle for more than 30 min, past the ~10 h max, or after logout-all. Keycloak's "Session not active" also maps here. | Re-login. |

### A.3 403: authorization

| Symptom | Cause | Fix |
|---|---|---|
| `CLIENT_INSUFFICIENT_SCOPE: service account does not have required scope: <scope>` | Your API client (SA) lacks the scope mapped to this API id, for example `tokens:transact`, `tokenClassConfigs:create` or `keys:create`. | Ask the Finternet platform team to add it (`/v1/clients/scopes/update`, replace semantics). Protected scopes need superadmin approval. |
| `USER_INSUFFICIENT_SCOPE` | User-scope gate. This check is **environment-dependent**. | Ask the operator to grant the user scope (`/v1/users/scopes/update`). |
| `FORBIDDEN: client is not allowed to perform this operation` | The client has `allowedOperations` rules (for example only `payload.operation ∈ [transfer, burn]`). | Ask for the rule to be widened, or use another client. |
| `FORBIDDEN: User not authorized: no_matching_allow_rule` (sync on get/transact, or async) | The caller is not the owner and holds no identity or delegation on this token. **Most common cause:** the token was minted with a hand-written `identities[]` array. The server re-hashes the ids, the auto-populated issuer/owner is replaced, and the minter loses its rights. A second common cause is acting from a different account than the one that registered or minted. | **Never send `identities[]` on `/token/mint`.** Re-mint without it. Do all class registration and writes from ONE operator account. To grant others access, use delegations. **The broken token can't be deleted** (there is no delete API). Whoever's hash ended up in `identities` holds the rights: if you sent plaintext addresses, the re-hash equals those accounts' real hashes, so they can act on it (burn it if the program has `burn`, or grant you a delegation); if you sent hashes, they were double-hashed and nobody holds rights. Mark it void in your system, store the replacement tokenId, and ask Finternet if it must be cleaned up at platform level. Your business-id search won't return it, because search only returns tokens where you are an identity. |
| `FORBIDDEN: user is not authorized to mint tokens for this class` | Caller is not an `issuer` identity on the class. Seeded classes are owned by their seed accounts. | Register your own class (the registering caller becomes owner and issuer), or have the class owner add you as an issuer. |
| `FORBIDDEN: operation denied by active deny delegation on label '...'` | A deny delegation shadows the allow. | Revoke the deny with `delegation-revoke`, or use another label. |
| `FORBIDDEN: not authorized to access this transaction` when polling | You are polling `/transaction/status` with a session that is neither the initiator nor an identity on the token. Typical case: polling a sessionless `/token/add` credential with the operator's JWT. | Poll with the **owner's** session. For transfer/federation saga detail, `POST /v1/transactions/status {"txn_id"}` (SA-level) is also available. |
| 403 on `/token/get` | Caller is not an identity on the token and has no delegation. | Read as the owner, or create a `view` delegation (`tokens:id:<uuid>`). |
| `FORBIDDEN` on `/token/add` (owner mismatch) | With a user JWT present, `owner` must equal the session account. | Either drop the user JWT and send `owner = sha256(address)`, or drop `owner` and call as that user. |
| `FORBIDDEN: Wallet address not registered` | Proxy `walletAddress` is not an active key of the owner. | `/v1/account/keys/register {address|publicKey}` first. |
| `FORBIDDEN` on `/v1/clients/register`: "client registration currently requires a superadmin service account (interim governance)" | Direct API registration is restricted. | Use the web portal's **API Access → Register client** (self-serve; see portals-and-access.md), or ask the Finternet platform team. The web app has an "API Access → Clients" page. |
| `OIDC_CLIENT_API_NOT_PERMITTED` | A third-party OIDC ("Login with Finternet") session called a non-allowlisted API (flag `enableOidcClientSessionEnforcement`). | Allowed: token get/search/transact/transactions, transaction status/get/search, account get. |
| `TERMS_CONSENT_REQUIRED` | Consent gate (flag `enableConsentEnforcement`, default off) is on and the user has not accepted the latest terms. | `/v1/terms/get` then `/v1/terms/accept`. `/account/get` shows outstanding consents. |

### A.4 404 / 409 / 429 / 5xx

| Symptom | Cause | Fix |
|---|---|---|
| `RESOURCE_NOT_FOUND: Endpoint Not Found` | Wrong path. Common ones: `/v1/token/transfer` (does not exist), `/v1/api-clients/*` (removed), `GET /v1/did/:address` (disabled), or a missing `/v1` prefix. | Transfers go through `/v1/token/transact {operation:"transfer"}`. Clients are under `/v1/clients/*`. DIDs resolve via `POST /v1/address/resolve`. |
| `RESOURCE_NOT_FOUND: Token class not found` | Class key mismatch. Keys are UPPER-CASED server-side and the DB lookup is case-sensitive, so mixed-case seeded `USDe`/`crvUSD` cannot be reached. | Use upper-case class keys. |
| `RESOURCE_NOT_FOUND: Token not found` | Wrong or stale tokenId, or you passed the txId by mistake. | Resolve the tokenId from `/transaction/get` (see B.3). |
| `RESOURCE_NOT_FOUND: Owner address not found` (`/token/add`) | `owner` is plaintext or a DID, or the account does not exist on this instance. | `owner` = `sha256(lower(trim(address)))` hex with no `0x`. This equals the user's JWT `preferred_username`. |
| `RESOURCE_NOT_FOUND: recipient_address_not_found` / `Recipient address not found` | The transfer recipient could not be resolved through the registry. **Live sanctum (Aug 2026): every fungible transfer failed this way**, whether the recipient was given as hash, DID or DID hex. This is an open issue. A suspected prerequisite is that the recipient has a registered key (`/v1/account/keys/register`). | Confirm `to` is the plaintext address of an account that exists. Ask the recipient to register a key. If it still fails, escalate it as a known open issue (see [known-gaps.md](known-gaps.md)). |
| `CONFLICT: Token class already exists` / `Token program already exists` | Class keys are **globally unique** across tenants. | Pick a namespaced key, for example `ACME-LOAN`. If you own it, use `/tokenclass/get` and reuse it. |
| `CONFLICT` on proxy `/token/add` (sessionless duplicate) | Same (owner, chain, contract, wallet) already imported. | Call with the owner's session to trigger `reconcile` (balance refresh). |
| `CONFLICT: sender account is homed on another instance` | Federation: the writer's home instance is elsewhere. | Send writes to the account's home instance. |
| `FORWARD` (409) on login | The account is homed on another UNITS instance. The message names it, but the `api_url` is not returned. | Log in against the home instance. |
| "Credential already exists. Cannot add duplicate credential." (async `VALIDATION_FAILED` at poll time, not a sync 409) | Duplicate credential add. | Treat it as success and fetch the existing token. |
| `409` from registry on client register | Per-account or per-client limits reached. | Ask the platform team. |
| `TOO_MANY_REQUESTS` (429) | Registry rate tier × scope limit. OTP rate limits return 429 with `EXTERNAL_SERVICE_ERROR`. | Honour `Retry-After` and use exponential backoff. Don't poll faster than ~1/s per tx. |
| `SCOPE_MAPPING_NOT_CONFIGURED` (500) | This API id has no row in the registry scope catalogue. Known unmapped: `api.clients.rotate_secret`, `api.clients.reactivate`, `api.clients.scopes.update`, `api.users.scopes.update/get`, `api.registry.forwarding.get`, and `api.account.refresh` on some builds (units-services#193). Superadmin SAs bypass it. | Report it to the platform team. You cannot fix it client-side. |
| `INTERNAL_ERROR: federation service is not configured` / `transact_not_routed` | Instance misconfiguration. | Report it with the `msgId`. |
| `DATABASE_ERROR` (500) | DB failure. | Retry with backoff. If it persists, report it. |
| `NOT_IMPLEMENTED` (501) on `/account/keys/rotate` | Key rotation is not built. | Register a new key and remove the old one. |
| `EXTERNAL_SERVICE_ERROR` (503) "registry service unavailable" | The central registry is unreachable. SA auth fails closed. | Retry with backoff. If it persists, the registry is down: check the environment status (the sandbox is available ~08:00–21:00 IST weekdays). |
| `EXTERNAL_SERVICE_ERROR` (503) Keycloak/Vault/Kafka/OTP unavailable | Dependency down. | Retry later. On the sandbox, check you are inside the availability window. |
| `AUTHZ_LOOKUP_FAILED` (503) | Transient scope-catalogue lookup failure. | Retry. |
| Connection refused / timeouts on `units.sanctum.finternetlab.io` | The sandbox is available ~08:00–21:00 IST on weekdays. The dev (foundry) host is not a supported integration target. | Work inside the sandbox window. Don't depend on the foundry host. |

---

## B. Asynchronous errors (surface at `/v1/transaction/status`)

Poll `POST /v1/transaction/status {"txId": "..."}` until `status ∉ {submitted, pending, processing, executing}`. The terminal states are `completed | failed | cancelled`. `awaiting_signature` means a proxy flow needs a user-signed chain tx. On failure, read `response.error.code` / `message`.

### B.1 Error catalogue

| `error.code` / message | Cause | Fix |
|---|---|---|
| `UNSUPPORTED_TOKEN_STANDARD` | Class `tokenStandard` is not on the bound program's whitelist. The match is exact, so `UNITS-Credential`, `ERC20` or `UNITS-LOAN` on a fungible program all fail. | Use an allowed standard: `fungible` takes UNITS-FT/ERC-20/ERC-3643, `non-fungible` takes UNITS-NFT/ERC-721, `credential` takes UNITS-CREDENTIAL/UNITS-SBT/W3C-VC-2.0, `stables` takes PROXY-FT, `purpose-bound-voucher` takes UNITS-SFT, `loan-nft-program` takes UNITS-Loan (also UNITS-NFT/UNITS-LOAN), `loan-pool-nft-program` takes UNITS-LoanPool (also UNITS-NFT/UNITS-LOANPOOL), `hello-token` takes UNITS-HELLO. Re-register the class (new key) or `/tokenclass/update` the standard. |
| `CAPABILITY_DENIED: program 'purpose-bound-voucher' does not support federation primitive 'domain_lifecycle' (supported: [Lock, CommitDebit, ...])` | Voucher `mint`/`issue`/`redeem`/`revoke` on current builds. The program's capability set has no DomainLifecycle. | **Not fixable by you.** Vouchers can't be minted today. Enforce purpose-spend off-ledger, or use a `fungible` class plus your own category rules. Track it in [known-gaps.md](known-gaps.md). |
| `CONFIG_NOT_FOUND` / `ConfigNotFound` | No active token class config row for the class. | `/v1/tokenclassconfig/register`. |
| `PROGRAM_NOT_FOUND` | Config `programId` is not a program compiled into the engine (for example `reference-ft`, `nfh-voucher`, `loan-nft`, `my-custom-program`). | Use a live id: `fungible`, `non-fungible`, `credential`, `stables`, `purpose-bound-voucher`, `loan-nft-program`, `loan-pool-nft-program`, `hello-token`. Then `/tokenclassconfig/update`. |
| `INVALID_PAYLOAD: unknown variant 'borrower', expected one of ...` | Identity `type` outside the enum. | Allowed lowercase types: `issuer, creator, owner, co-owner, operator, viewer, access`. Better still, don't send identities on mint. Put domain roles such as borrower/lender in `data`. |
| `INVALID_PAYLOAD: ... invalid digit found in string` (for example `Invalid LoanOriginatedPayload: invalid digit found in string`) | Decimal or non-numeric value in a u128 field (`"12.29"`, `"1,000"`, `"5e6"`). | Loan u128 fields are **integer strings** in minor units: `"1229"` not `"12.29"`. |
| `INVALID_PAYLOAD: invalid type: string, expected u32` (or similar) | u32 fields (tenure, emiDay, tranche, counts) sent as strings. | Send JSON numbers for u32 fields, for example `"tenure": 36`. |
| `foir must be in (0, 1], got 0` | `foir` sent as `"0"` or out of range. Current code expects an integer string 1–10000 (basis points); the message text is outdated. | Send `"1"` (valid on all builds). |
| `INVALID_PAYLOAD: missing field 'value'` / `missing field 'amount'` | Loan amount ops (`loan_disbursed`, `payment_received`, `charge_levied`, `penal_charge_levied`): current code (token-runtime #220) needs `data.value`; older builds (e.g. sanctum Aug 2026) need `data.amount`. **Environment-dependent.** | Send the field the error names (unknown keys are ignored, so sending both also works). |
| `INVALID_PAYLOAD: Mint payload must include an Issuer or Owner identity` | The engine could not derive an owner. This is rare with normal API usage. | Mint with a user session. Don't override identities. |
| `INVALID_PAYLOAD: rejecting state-mutating operation ... with no federation context` | Engineers only: a message was published straight to Kafka, bypassing units-api. | Every write must go through units-api (StartDomainLifecycle / StartTransfer). |
| `TOKEN_NOT_FOUND` / `<class>:<op> requires token_id` | A non-create loan or pool operation without `tokenId`, or a stale id. | Pass the tokenId of the loan or pool. |
| `INSUFFICIENT_BALANCE` | Amount > spendable (balance − locked), often because of a display/raw mix-up (see C). | Check the balance with `/token/get`, and check `valueFormat`. |
| `INVALID_TOKEN_STATUS` (for example `burned (already revoked)`, `resume (credential is not suspended)`) | Operation not allowed in the current state. Credential: suspend needs `active`, resume needs `frozen`, revoke is terminal (`burned`). Fungible freeze/burn/lock require `active`. (Token `state.status` is lowercase; PascalCase values like `Active` belong to domain enums in `data`, e.g. `loanEntityStatus`.) | Read the state first, then choose a valid transition. |
| `TOKEN_FROZEN` / `TOKEN_LOCKED` | The token is frozen or the units are locked. | `unfreeze`/`unlock` first (needs the right identity). |
| `UNSUPPORTED_OPERATION: Credential program does not support 'X'...` | Credential supports only `add, revoke, suspend, resume`. | Don't transfer or burn credentials. Revoke and re-issue instead. |
| `UNAUTHORIZED` / `VALIDATION_FAILED` (program level) | Program-level checks, for example voucher category not permitted or cap exceeded. | Fix the input. The failed tx is still recorded. |
| `HOOK_FAILED` | A configured pre/post hook rejected the operation (for example `credential-verification`: the holder lacks Active credentials of the required classes). | Read the message, satisfy the precondition, and retry with a new msgId. |
| `MIN_BALANCE_VIOLATED` | `min-balance` hook: transfer/burn/lock/debit would take the balance below class `metadata.minBalance`. | Use a smaller amount, or change the class metadata. |
| `MAX_SUPPLY_EXCEEDED` | `max-supply` hook: mint would exceed class `metadata.maxSupply`. | Use a smaller mint, or raise `maxSupply` (`/tokenclass/update`; metadata is a full replace). |
| `DATA_INTEGRITY_VIOLATION` | The engine re-verified the token's stored state commitment and it did not match. Something changed the token outside the engine (a direct DB edit or a post-hook `modified_state` patch), or commitment config drifted. | Integrators: report it with the txId and tokenId, and stop writing to that token. Engineers: compare `state_history` (last `state_commitment`, `commitment_config`) with `tokens.state_commitment`. See section D.2. |
| `CONCURRENT_MODIFICATION` / `STATE_CONFLICT` | Optimistic version clash. Retryable, and the engine retries automatically. If it shows up as terminal, retries were exhausted. | Re-submit with a new msgId after checking the token state. Avoid parallel writes to the same token. |
| `FORBIDDEN: no_matching_allow_rule` (async) | Same as A.3. The usual cause is `identities[]` on a previous mint. | Re-mint without identities and use one operator account. |
| `RESOURCE_NOT_FOUND: recipient_address_not_found` (async in a transfer saga) | Same as A.4. | Same. |
| `UNKNOWN_ERROR` / `PROGRAM_ERROR` | Catch-all mapping, including in the DLQ. | Engineers: read `transactions.error.system` and engine logs (section D). |

### B.2 Status never reaches a terminal state

| Symptom | Likely cause | What to do |
|---|---|---|
| Stays `submitted` > 60 s | The workflow never started or the outbox is stuck. Restate down, Kafka down, or the outbox in retry (`outbox_delivery_stuck` after 10 attempts). On the sandbox, check you are inside the availability window. | Keep polling with backoff up to your timeout (2–5 min). Then check `/v1/transactions/status {"txn_id"}` (SA-level) to see the saga state. Escalate with the txId. Engineers: section D. |
| Stays `processing` / `executing` | The engine picked it up but did not finish. Possible causes: retrying a retryable DB error, a stables `sign` poll blocking the partition, or the completion callback not delivered. | Same as above. Check `primitive_ops.engine_status` and `completion_status`. |
| `/transactions/status` shows `STUCK` | Transfer saga: after the point of no return (CommitDebit) the destination outcome was unknown. Needs manual ops. | **Never retry a STUCK transfer yourself.** You might double-credit. Escalate with the txId. |
| `/transactions/status` shows `ABORTED` / `REVERSED` | Prepare failed (Lock/CreateIncoming), so compensations ran (Unlock/RejectIncoming), or a commit failure was auto-reversed. | Funds are back with the sender. Read `last_error`/`ops[]`, fix, and re-submit. |
| `awaiting_signature` | Proxy (PROXY-FT) flow: `transaction/get.responseData.unsignedTx` must be signed on-chain by the user. | Sign and submit per the proxy flow ([token-classes.md](token-classes.md)). |

### B.3 Mint succeeded but you can't find the token

There is no tokenId in the mint response. Resolve it in this order:
1. `POST /v1/transaction/get {"txId"}`: read `response.metadata.token_id`, then `response.metadata.affectedTokenIds[0]`, then the legacy `response.responseData.tokenId` / `.id` (see `api-reference.md` §5.5.2).
2. Fallback: `POST /v1/token/search {"filters":{"tokenClass":"ACME-LOAN"},"pagination":{"limit":1,"offset":0},"sortBy":{"field":"createdAt","order":"desc"}}` and take `response.tokens[0].id`. This races with parallel mints, so prefer filtering on your own business id in `data.*` (for example `{"filters":{"data.loanRefId":"LN-001"}}`).
3. Search only returns tokens where **the caller** is an identity. If it comes back empty, you may be searching as the wrong account.

---

## C. Silent wrong behaviour (no error, wrong result)

| Symptom | Cause | Fix |
|---|---|---|
| Minted 1000 but the balance shows 1000 × 10^decimals (or a transfer moved far more or less than intended) | `context.valueFormat` was left out. **The code default is `display`**, while schema text says raw. A raw base-unit string was then scaled by `decimals` a second time. | Always send `context.valueFormat` explicitly (`"raw"` = base-unit integer strings, `"display"` = decimals using class `metadata.decimals`). Use the same value on reads. |
| Fractional digits disappeared | `ConvertToBaseUnits` silently truncates digits beyond `decimals`. | Validate precision client-side. |
| A transfer of `"0"` succeeded | Zero amounts are accepted on plain FT. Positivity is only enforced for vouchers and proxies. | Validate amount > 0 client-side. |
| A second mint to the same owner did not create a new token but increased supply on the existing one | Fungible tokens have **no batch identity**. Mint/credit merges into the owner's oldest token of that class. | Use NFT/loan-style classes for per-item identity, or one class per batch (not recommended). See [known-gaps.md](known-gaps.md). |
| A retry created a duplicate token | No idempotency key. Each POST is a new mint. | Dedupe on your own business id before submitting. Use a fresh `msgId` per attempt. Before re-submitting after a timeout, search by business id first. |
| Mint "worked" but later transacts are FORBIDDEN | `identities[]` was sent on mint (see A.3). | Don't send identities. |
| Class `schema` declares required fields, but a mint without them succeeded | The class `schema` is documentation only. **It is not enforced** by the API. Programs validate their own structs. | Validate `data` client-side against your schema. |
| `operationOverrides: {"transfer":{"disabled":true}}` set, but transfers still work | Stored but **not enforced** by the engine. | Enforce it in your app, or use a non-transferable program / `metadata.transferable:false` where the program honours it. |
| Hook config `config:{...}` has no effect | `HookConfig.config` is not passed to hooks. Hooks read class metadata or config instead. Unknown `hookId`s are silently skipped. | Put limits in class `metadata` (`maxSupply`, `minBalance`). Spell hook ids exactly: `validation, logging, max-supply, min-balance, credential-verification`. |
| `update` overwrote attested data | `update` shallow-merges into `token.data` with no immutable-field protection. | Restrict who has `manage`. Keep attestations in credentials (revoke/re-issue) rather than mutable `data`. |
| `/transaction/proof` stays `pending` forever | Merkle batches are only generated when a **full batch** (e.g. 100) of completed txs accumulates. There is no time-based flush, and the batch service may not be running. | Treat the per-token state commitment (on `token/get`) as the live tamper-evidence. Expect `pending` on low-traffic instances. |
| `/transaction/proof/verify` returns `valid:true` but it proves little | Verify is structural only. Chain anchoring is not implemented yet (roadmap). | Say "hash-chained, tamper-evident", never "anchored on blockchain". To verify independently, recompute the leaf hash and Merkle path yourself ([concepts.md](concepts.md)). |
| `/account/get` shows the address as `p***ha` | PII is masked. | Record the plaintext address and its sha256 hash **at signup**. You can't recover the hash later through the API. |
| The DID in `/account/get` does not match the hash you use in `owner` | They are unrelated. DID = `did:units:0x<ed25519 pubkey hex>`. Stored identity = `sha256(lower(trim(address)))`. | Use the hash for `/token/add owner`, the plaintext address everywhere else. |
| The issuer can still see tokens after transferring them | Tenant scoping is by any identity containment, and the issuer identity remains. | A known privacy gap. Don't rely on loss of visibility. |
| Pool mint OK but loans show no pool membership | The LOAN-POOL `tokenIdsFrom: payload.loan_token_ids` seed likely fails to resolve after unwrap. | Engineers: fix the seed to `payload.data.loan_token_ids`. Integrators: verify the loan state after pool mint. |
| A user burn did not reduce total supply | A user burn credits the issuer pool (only an issuer burn is permanent). | Burn from the issuer, or treat user burns as "return to issuer". |
| A credential `suspendUntil` passed but it stays suspended | Nothing in UNITS fires on time. There is no auto-resume or auto-expiry. | Run your own sweeper that calls `resume`/`revoke`. |

---

## D. Debugging a stuck or failed transaction

### D.1 Integrator procedure (API only)

1. **Keep the identifiers.** Log `msgId`, `X-Correlation-ID` (response header), `txId` (`response.txId` / `context.transactionId`), the full request (minus secrets) and the full response.
2. **Poll with the right session.** `POST /v1/transaction/status {"txId"}` with the user JWT of the initiator, or of an identity on the token. For sessionless `/token/add`, use the owner's session. A 403 here means the poll used the wrong session, not that the write failed.
3. **Read the error.** On `failed`, map `response.error.code` with section B.
4. **Get details.** `POST /v1/transaction/get {"txId"}` returns `status`, `error`, `responseData` (`unsignedTx` and tokenId for proxy flows), `metadata.token_id` and `metadata.affectedTokenIds`, `operationName`, `timestamps`, `proofId`.
5. **Check the saga (transfers / federation).** `POST /v1/transactions/status {"txn_id":"<txId>"}`. The key is snake_case, and the call is SA-level (developer token; no user JWT needed). It returns `SUBMITTED|PREPARED|COMMITTING|COMMITTED|ABORTED|AUTO_REVERSING|REVERSED|STUCK`, `ops[{op_seq, op_type, result, details}]` and `last_error`.
6. **Check the token itself.** `POST /v1/token/get {"tokenId"}` gives state, balance, version and commitment. `POST /v1/token/transactions {"filters":{"tokenId":"..."}}` gives per-token history (debit/credit entries, stateBefore/stateAfter).
7. **Check the class binding.** `/v1/tokenclass/get {"tokenClass"}` (note `tokenStandard`, `identities`) and `/v1/tokenclassconfig/get {"tokenClass"}` (note `programId`, hooks). Compare against `/v1/tokenprogram/search` (supported standards and operations).
8. **Decide.**
   - `failed` with a validation code: fix it and re-submit with a **new msgId** (check first that it really failed, so you don't create duplicates).
   - Still `submitted`/`processing` after your timeout: don't re-submit blindly. Search by business id to confirm nothing was created, then escalate.
   - `STUCK`: escalate. Never retry.
9. **Escalate** with environment, `msgId`, `txId`, correlation id, timestamps, and the redacted request/response. Use Discord or the engineering email in the public docs Help page.

### D.2 Engineer procedure (cluster/DB access)

Column names follow units-api DDL (`specs/db/*.sql`). Check them against your schema version.

**1. Transaction row (API + engine view)**
```sql
SELECT id, status, status_v2, error, metadata, timestamps, workflow_instance_id, proof_id, created_at, updated_at
FROM transactions WHERE id = '<txId>';
-- status: submitted → pending → processing → completed|failed|cancelled (|awaiting_signature)
-- status_v2 (saga): submitted|prepared|committing|committed|aborted|auto_reversing|reversed|stuck
-- error = {"code": user_code, "message": user_message, "system": <raw engine error>}
-- metadata.affectedTokenIds, metadata.operation, metadata.token_class_id; plan_data = the saga plan
```

**2. Primitive ops (the per-step engine contract and idempotency)**
```sql
SELECT txn_id, op_seq, engine_status, engine_result, engine_executed_at,
       completion_status, completion_attempts, completion_next_at, completion_error, completion_sent_at
FROM primitive_ops WHERE txn_id = '<txId>' ORDER BY op_seq;
```
- No rows: the plan never admitted a step. Look at units-api logs or Restate.
- `engine_status IS NULL`: the command has not executed yet. Check the Kafka outbox (API side, `PrimitiveOutbox` 5 s tick, `outbox_delivery_stuck` WARN after 10 attempts) and engine consumer lag.
- `engine_status='executed'` but `completion_status` is `failed`/`pending`: the engine finished but the completion callback did not reach the workflow. Check `completion_error`. The outbox retries with backoff up to 60 s.
- `engine_status='failed'`: read `engine_result.errorCode` / `errorMessage`.

**3. What changed on the token**
```sql
SELECT id, tx_id, token_id, operation, entry_type, units, participants, created_at
FROM token_transactions WHERE tx_id = '<txId>';

SELECT token_id, state_version, state_commitment, previous_commitment, commitment_config, token_tx_id, timestamp
FROM state_history WHERE token_id = '<tokenId>' ORDER BY state_version DESC LIMIT 5;

SELECT id, token_class, state_version, state_commitment, identities, state, updated_at
FROM tokens WHERE id = '<tokenId>';
```
- For `DATA_INTEGRITY_VIOLATION`: `tokens.state_commitment` should equal the latest `state_history.state_commitment`, and each row's `previous_commitment` should equal the prior row's commitment. A mismatch with no matching state_history row points to an out-of-band write or a post-hook patch.
- Wrong owner or identities: inspect `tokens.identities` (hashed ids plus types). Hashes of literal role strings (for example `sha256("lender-x")`) mean someone sent `identities[]` on mint.
- As-of state: `SELECT DISTINCT ON (token_id) * FROM state_history WHERE token_id = $1 AND timestamp <= $T ORDER BY token_id, state_version DESC;`

**4. Class binding as the engine sees it**
```sql
SELECT token_class, program_id, status, pre_hooks, post_hooks, config FROM token_class_configs WHERE token_class = 'ACME-LOAN';
SELECT token_class, token_standard, metadata->'fungible', identities FROM token_classes WHERE token_class = 'ACME-LOAN';
SELECT program_id, supported_standards, supported_operations FROM token_programs;  -- engine self-registers at boot
```
Missing `metadata.fungible` defaults to **true** in the engine, which matters for NFT-like classes.

**5. Restate (saga / workflow)**
- Token operations run as `PrimitiveOperationWorkflow` keyed by the txId. Transfers use the `transfer` workflow. The workflow state is in the units-workflows DB `workflows` table and is queryable through the workflow's `getStatus` handler at `<RESTATE_INGRESS_URL>/PrimitiveOperationWorkflow/<txId>`. Use the Restate admin/CLI to inspect the invocation journal.
- Each step waits on durable promise `primitive:<txId>:<opSeq>` with a default timeout of **30 s**. A timeout before the point of no return gives ABORTED. After the PONR (CommitDebit, opSeq 3), the workflow queries destination status and ends COMMITTED, REVERSED or STUCK.
- `STUCK` needs a human to decide: query the destination instance's `primitive_ops` for CommitCredit, then either complete it or credit back. Record the decision.

**6. Kafka / engine**
- Command topic `units.token.operations` (key = txId, so there is **no per-token ordering**). DLQ topic `units.token.operations.dlq`.
- DLQ message: `{original_payload, error, error_code, retry_count, failed_at, original_partition, original_offset, context}`. Because of a known bug, `context.tx_id`/`token_class` are always null, so read the txId from `original_payload`. Many errors map to `UNKNOWN_ERROR`. `transactions.error.system` has the raw text.
- Engine retries only DB/Kafka/ConcurrentModification/CompletionCallback errors (3 attempts by default). Program errors are never retried.
- Serialization failures go to the DLQ with **no transaction row** (txId unknown).
- The consumer is sequential per pod, and stables `sign` polls synchronously, so a slow chain call blocks its partition.
- Engine health: `GET /health/ready` (DB + Kafka). Observability: OTel → ClickStack/HyperDX. Search by `msgId` / correlation id.


---

## E. "Docs say X, reality is Y" truth table

Sources: public docs at docs.finternetlab.io, OpenAPI/specs repo, and repo CLAUDE.md/README files. Reality comes from code at HEAD and from live sanctum (Aug 2026).

| # | Topic | Docs / spec say | Reality (Oct 2026) |
|---|---|---|---|
| 1 | Developer token transport | OpenAPI: `Authorization: Bearer <devToken>` or `X-Finternet-Signature` headers. Security-model page: "body or header". | **Body only**: `context.developerToken`. `Authorization` and `X-Developer-Token` headers are ignored. The only header read is the optional `X-Correlation-ID`. |
| 2 | User JWT transport | Help page / accounts page: "JWT in the `Authorization` header". | `context.authorization: "Bearer <jwt>"` in the body. |
| 3 | Developer token format | `fnt_...` keys, `dev-token-...`, `dev_pk_test_token`, `allowedDeveloperTokens` allowlist. | `base64("sa-<client-uuid>:<secret>")`, which always starts `c2Et`. Resolved against the central registry. The allowlist was removed. |
| 4 | API client endpoints | Changelog / units-api CLAUDE.md: `/v1/api-clients/*`, `/v1/api-clients/keys/create`, `/update-scopes`. | `/v1/clients/{register,get,list,update,deactivate,reactivate,rotate-secret,scopes/update}`. No per-key revocation: deactivate the client or rotate the secret. |
| 5 | Getting credentials | "Self-service API clients". | True **through the web portal** (API Access → Register client), which registers with a platform credential. Calling `/v1/clients/register` directly **requires a superadmin SA** (interim governance). |
| 6 | Program ids | Changelog / crate READMEs: `reference-ft`, `reference-nft`, `reference-credential`, `nfh-voucher`, `loan-nft`, `loan-pool-nft`. | Live ids: `fungible`, `non-fungible`, `credential`, `purpose-bound-voucher`, `loan-nft-program`, `loan-pool-nft-program`, `stables`, `hello-token`. Old names give PROGRAM_NOT_FOUND. |
| 7 | Program operations | Seed rows: credential has `issue/update_status`. Loan seed lacks `mint`. Docs: credential "mint/burn". | Engine self-registration is authoritative. Credential: `add, revoke, suspend, resume`. Loan: `mint` (= `loan_originated`) + 22 domain ops. |
| 8 | Voucher program | Docs: voucher supports mint/issue/redeem/revoke. | `purpose-bound-voucher` lacks DomainLifecycle, so mint/issue/redeem fail with `CAPABILITY_DENIED` on current builds. |
| 9 | `entityType` | Quickstart / account docs / Postman: `"individual"`, `"Individual"`. DB comment: Individual/Business. | Schema: **`PERSONAL` \| `BUSINESS`**. Anything else returns 400. |
| 10 | `valueFormat` default | Schema / specs text: raw is the default. | **Code default is `display`**. Always send it explicitly. |
| 11 | Amount field on transact | Old docs, fungible README, test scripts: `amount`. | `value` (PR #109). `amount` returns 400. In old Kafka scripts, a burn with `amount` burned the entire balance. Domain ops keep their own names inside `data`. |
| 12 | Identities on mint | Quickstart: mint with `identities:[{id:"ALICE_ADDRESS", type:"owner"}]`. OpenAPI examples include them. Old demo comments say "list operator in identities". | **Don't send them.** The engine auto-populates issuer/creator/owner from the caller. Hand-written ids get re-hashed and the caller loses rights (`FORBIDDEN no_matching_allow_rule`). |
| 13 | Scope vocabulary | Changelog: "15-scope RBAC". Concepts: 9 domains × 3 actions = 27. Specs: "13-resource × 3-action". User-scope example: `tokens:read/write`. Auth page: mint/transfer need `tokens:create`. | The registry catalogue is authoritative (`/v1/scopes/search`). Format `entity:action` with view/create/manage, plus `tokens:transact`. Includes `tokenClasses:*`, `tokenClassConfigs:*`, `keys:*`, `clients:*`, `workflows:*`, `terms:*`, `scopes:view`, `delegations:view`, `registry-*`. Transact needs `tokens:transact`. `tokens:read/write` do not exist. |
| 14 | Class schema | Some docs: "schema-validated token class", "schema validated on every mint/add". | **Not enforced** (the validator is dead code). It is documentation only. Programs validate their own payloads. |
| 15 | Security and compliance properties | Various docs describe encryption, signing, immutability and anchoring guarantees. | Don't make claims about encryption at rest, anchoring or audit immutability to your users; confirm current guarantees with Finternet. Don't put raw PII in token `data`. |
| 16 | Chain anchoring | Concepts: commitments anchored to external chains (`pending → proven → anchored`). | **Not implemented yet** (roadmap). Status stops at `proven` at best, and `pending` until a full batch exists. `proof/verify` is structural only. |
| 17 | Commitment algorithm | Docs: per-token SHA-256 `SHA-256(prev ‖ tx_id ‖ ts ‖ state)`, JS `JSON.stringify` recompute. | SHA-256 by default, BLAKE3 configurable per class (`stateCommitmentAlgorithm`). The fields are configurable (`stateCommitmentFields`), so a naive client recompute may not match. Merkle batches use BLAKE3. |
| 18 | DID endpoint | Concepts / older notes: resolve accounts at `GET /v1/did/:address`. DID method `did:web`. | `GET /v1/did/:address` is **disabled** (issue #56). Use `POST /v1/address/resolve`. Deployed DIDs are `did:units:0x<ed25519 pubkey hex>`. Specs also mention `did:key`, `did:nfh`, `did:fi`, all stale or illustrative. |
| 19 | Transfer endpoint | federation-interfaces.yaml: `POST /v1/token/transfer`. Changelog: "Unified Transact endpoint for mint, burn…". | No `/token/transfer` and no `/token/burn|freeze`. Use `/v1/token/transact {operation:"transfer"\|"burn"\|...}`. Mint stays `/v1/token/mint`. |
| 20 | Async success status | Quickstart: "When status is `successful`, the mint is complete". Event-processing: engine sets `successful`. | Envelope `context.status` is `successful` for the sync acceptance. The **transaction** terminal status is `completed` (or `failed`/`cancelled`). Mint/add return HTTP 200 + `submitted`. Transact returns 202 + `accepted`. |
| 21 | tokenId on mint | Quickstart: "Note the tokenId from the [status] response". | Neither mint nor status reliably returns it. Use `/transaction/get` (`metadata.token_id` / `metadata.affectedTokenIds`) or search. |
| 22 | Webhooks | Event-processing diagram: Engine → "Webhooks". Example hook `notify-webhook`. | **No webhooks, SSE or websockets** anywhere. Poll. |
| 23 | Kafka partitioning | "Ordering per token (partition by token ID)". "Idempotent by tx id". | Key = **txId**, so there is no per-token ordering (same-token ops can race; optimistic locking + retry). Idempotency exists on `(txn_id, op_seq)` for primitive ops. There is **no request-level idempotency key**. |
| 24 | Signature on transact | Auth page: required. Manage-supply examples: omitted. | Enforcement is **environment-dependent**; always build signing in. `jws` is a raw Ed25519 signature over JCS(payload), not a compact JWS. |
| 25 | Local stack | Building README: "Run the full UNITS stack locally with Docker Compose". Env-setup page: "hosted Foundry only; no local stack". | Engineers can run the stack locally (units-api docker compose on `localhost:3000`, see [local-development.md](local-development.md)). External integrators should use the sandbox (sanctum). The dev/foundry host is not a supported integration target. |
| 26 | Environments / hosts | Docs: base URLs "to be disclosed". Api-clients example: `https://api.finternetlab.io`. Only "Foundry" is named. | Staging (integrator sandbox): `https://units.sanctum.finternetlab.io`. Prod: `https://units.finternetlab.io`. Dev: `https://units.foundry.finternetlab.io` (may be unavailable). `api.finternetlab.io` is not a known UNITS API host. Production may run an older build than sandbox; re-test environment-dependent behaviour. |
| 27 | Class register path | Older docs: `/v1/registry/tokenclasses/register`. | Both `/v1/tokenclass/register` and the alias `/v1/registry/tokenclasses/register` work. |
| 28 | Class register fields | OpenAPI examples: `chainDeployments`, `status`. | Ignored. Use `metadata.contractIds{CAIP-2: address}` for proxies. |
| 29 | Proof API input | Concepts: `GetProof(tokenId)`. | `POST /v1/transaction/proof\|proof/leaf\|proof/verify {"txId"}`. |
| 30 | Claims | Concepts: AddClaim/RevokeClaim operations. | No generic claim operations. `claims` are attached at mint and stored but **never verified**. For attestations, issue credentials (`/token/add`). |
| 31 | Delegation scoping | Actors / payments pages: delegations limited by amount, frequency, time. | Delegation = label + permission (view\|transact\|manage) + allow/deny + optional `expires_at` + optional `allowedOperations`. There are no amount or velocity limits. |
| 32 | Delegation labels | Concepts: `token:{uuid}`, `tokenclass:{uuid}`. | `tokens:id:<uuid>`, `tokens:tokenclass:<CLASS>`, `tokens:*`, `tokens:tokenclass.metadata.status:active`. |
| 33 | Identity in tokens | Data-model: `hashed_address`. TokenState: "owner DID". Changelog: "wallet addresses replace DIDs". | Identity id = `sha256(lower(trim(address)))` hex (= JWT `preferred_username`). It is not a DID and not a wallet address. |
| 34 | OTP step-up on delegations | Older design docs: `stepUpToken`. | Removed (PR #284). Sending it returns 400 because schemas are closed. |
| 35 | Hooks catalogue | Docs: `audit-log`, `notify-webhook`. Older design docs: `escrow-transfer`, geofence, velocity… | Configurable hook ids: `validation, logging, max-supply, min-balance, credential-verification`. Engine-mandatory: commitment verification and audit log. Others don't exist and are silently skipped. |
| 36 | `operationOverrides` / token class "blocked ops" policies | Docs: class policies block operations via RBAC. | Stored, **not enforced**. |
| 37 | UNITS name | "Unified" vs "Universal Information Tokenisation System". | Both appear. Treat them as the same thing. |
| 38 | Token standards / ERC | Docs present ERC-20/721/3643 support. | These are labels that select a Rust program. There are **no smart contracts**. Don't claim ERC compliance. |
| 39 | Status vocab (federation) | README: lowercase `prepared, committing, committed`. | `/transactions/status` returns uppercase `SUBMITTED…STUCK`. `/transaction/status` returns lowercase `submitted…completed`. |
| 40 | `/transactions/status` vs `/transaction/status` | Easy to confuse. | `/transaction/status {"txId"}` needs a user JWT (initiator or identity). `/transactions/status {"txn_id"}` is SA-level federation/saga status. Integrators should prefer `/transaction/status`. |
| 41 | Session lifetime | Elsewhere "24 h access token". | Access token ~10 h (`expiresIn` 36000). Refresh idles out at 30 min. Refresh tokens are single-use. |
| 42 | Loan money fields | Loan-pool docs / older schemas: floats or numbers, `FLDG_update`. | Strings (u128 integer strings). Op names are lowercase (`fldg_update`). Loan keys are camelCase, pool keys snake_case. |
