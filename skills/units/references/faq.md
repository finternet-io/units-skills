# UNITS FAQ

Snapshot: 2026-10-03. These are short, concrete answers to the questions external integrators and engineers ask most. Each answer links to the reference file that covers the topic in depth. Things move, so verify program ids, standards and scopes against the live instance (`/v1/tokenclassconfig/get`, `/v1/tokenprogram/search`, `/v1/scopes/search`).

Unless a snippet says otherwise, examples use this envelope. In the snippets below, `{...ctx}` stands for this `context` object. Drop `valueFormat` everywhere except `/token/get|search|mint|transact` (closed contexts such as `/account/*` and `/token/add` reject it with 400), and drop `authorization` where a snippet says no session is needed.
```json
{ "context": { "id": "api.token.mint", "version": "1.0", "ts": "2026-10-03T10:00:00Z",
               "msgId": "<fresh uuid>", "developerToken": "<base64 sa-...:secret>",
               "authorization": "Bearer <user session JWT>", "valueFormat": "raw" },
  "payload": { } }
```

---

## A. Basics and concepts

**1. What is UNITS?**
UNITS (Unified, also written Universal, Information Tokenisation System) is the ledger and tokenisation platform of Finternet, a mission of Networks for Humanity (NFH). You register a token class (an asset definition), bind it to a token program (business logic), and then mint and operate tokens through a JSON-envelope REST API. A Go API publishes intents. A Rust engine is the only writer of token state, in PostgreSQL. Restate runs the multi-step sagas. Finternet is the wider vision: a network of federated UNITS instances. → [concepts.md](concepts.md), [architecture.md](architecture.md)

**2. Is UNITS a blockchain?**
No. It is a permissioned, account-based ledger on PostgreSQL. There is no consensus, mining or smart contracts. Every write gets a hash-chained **state commitment** (SHA-256 by default, BLAKE3 optional), and completed transactions are batched into BLAKE3 Merkle trees. That makes it tamper-*evident*. Chain anchoring is **not** implemented. Proxy tokens can mirror balances that live on real chains (CAIP-2 ids). → [concepts.md](concepts.md), [known-gaps.md](known-gaps.md)

**3. Does "ERC-20 / ERC-721 / ERC-3643" mean my tokens are on Ethereum?**
No. Those strings are `tokenStandard` labels that select a Rust program (`fungible` accepts UNITS-FT/ERC-20/ERC-3643). No contract is deployed. Don't claim ERC compliance. → [token-classes.md](token-classes.md)

**4. What's the difference between a token class, a token class config and a token program?**
- **Token class**: the definition of a kind of token (for example `ACME-BOND`), with `tokenStandard`, `name`, `schema` (documentation only), `identities` (who may mint) and `metadata` (decimals, symbol, maxSupply, transferable…). Registered with `/v1/tokenclass/register`.
- **Token program**: Rust business logic in the engine that defines which operations exist and how state changes (`fungible`, `credential`, `loan-nft-program`…).
- **Token class config**: the binding that connects a class to a program, plus hooks and engine config. Registered with `/v1/tokenclassconfig/register`. Without it, every operation fails `primitive_capability_missing`.

A rough analogy: the class is the instrument master record and the program is the contract code it runs on. → [token-classes.md](token-classes.md), [token-programs.md](token-programs.md)

**5. What token programs exist?**
| programId | standards | use for |
|---|---|---|
| `fungible` | UNITS-FT, ERC-20, ERC-3643 | balances: mint, burn, transfer, freeze/unfreeze, lock/unlock, update |
| `non-fungible` | UNITS-NFT, ERC-721 | unique items: mint, burn, transfer, lock/unlock |
| `credential` | UNITS-CREDENTIAL, UNITS-SBT, W3C-VC-2.0 | soulbound W3C VCs: add, revoke, suspend, resume (via `/token/add`) |
| `stables` | PROXY-FT | proxies of on-chain stablecoins: import, reconcile, transfer, sign |
| `purpose-bound-voucher` | UNITS-SFT | category-capped vouchers (**mint currently blocked**) |
| `loan-nft-program` | UNITS-Loan (also UNITS-NFT, UNITS-LOAN) | loan lifecycle (`mint` = `loan_originated` + 22 domain ops) |
| `loan-pool-nft-program` | UNITS-LoanPool (also UNITS-NFT, UNITS-LOANPOOL) | securitisation pools |
| `hello-token` | UNITS-HELLO | exemplar for program authors |

→ [token-programs.md](token-programs.md)

**6. Can I define my own token program?**
Not self-serve. Programs are compiled into the token engine binary. `/v1/tokenprogram/register` can create a registry row, but it cannot make an operation executable. A custom program is Finternet engineering work: a Rust `TokenProgram` implementation, a PR to units-token-runtime and an engine release, typically "days" per program. Most needs are met by registering a **class** on a stock program and putting domain fields in `data`/`metadata`/`extensions.<programId>`. Dynamic (WASM) program loading is on the roadmap, in design. → [authoring-token-programs.md](authoring-token-programs.md)

**7. What is a "token" concretely?**
A row the engine owns. It has `id` (UUIDv7), `tokenClass`, `identities` (hashed account ids with roles), `data`, `metadata`, `state` (balance/supply/status/locks), `state_version` and `state_commitment`. Every change writes a `token_transactions` row (before/after, debit/credit) and a `state_history` snapshot. → [concepts.md](concepts.md)

**8. What does "federated" mean here?**
Every account has one **home instance**. A central **registry** holds routing metadata (address → DID → home instance), developer clients and scopes, delegations, and instance capability documents. Cross-instance transfers run as a saga across instances. Logging in against the wrong instance returns `409 FORWARD`. → [architecture.md](architecture.md)

**9. What is a proxy token?**
A UNITS-side shadow of an on-chain balance, keyed by (owner, CAIP-2 `chainId`, `contractAddress`, `walletAddress`). The chain is the source of truth. UNITS mirrors it and records shadow debits and credits. It is imported with `/v1/token/add` using chain fields, under a PROXY-FT class bound to `stables`. → [token-classes.md](token-classes.md)

**10. What are hooks?**
Per-class pre/post processors configured in the class config: `{"hookId","priority","enabled","operations":[...]}`. The available ids are `validation`, `logging`, `max-supply` (reads `metadata.maxSupply`), `min-balance` (reads `metadata.minBalance`) and `credential-verification`. Unknown ids are silently skipped. The hook's `config` object is not passed to hooks, so put limits in class metadata. → [token-classes.md](token-classes.md)

---

## B. Access, environments and onboarding

**11. How do I get API access?**
Self-serve it: log in to the web portal (https://sanctum.finternetlab.io for the sandbox, https://my.finternetlab.io for production) → **API Access → Register client** → choose scopes → copy the developer token (shown once). See [portals-and-access.md](portals-and-access.md). If API Access isn't available, email engineering@finternetlab.io. Calling `/v1/clients/register` directly needs a superadmin service account, which the portal handles for you. You receive a `developerToken` (`base64("sa-<client-uuid>:<secret>")`, starting `c2Et`) **once**, along with the scopes you need. Some environments also offer an "API Access → Clients" page in the web app. → [auth-and-onboarding.md](auth-and-onboarding.md)

**12. Which environment should I use?**
Use **staging ("Sanctum")** as your integrator sandbox: API `https://units.sanctum.finternetlab.io`, web app `sanctum.finternetlab.io`. It is available ~08:00–21:00 IST on weekdays. Prod is `https://units.finternetlab.io` (app `my.finternetlab.io`); production may run an older build than sandbox, so re-test environment-dependent behaviour. Dev ("Foundry", `units.foundry.finternetlab.io`) is not a supported integration target, so don't rely on it. Engineers can also run a local stack on `http://localhost:3000`. → [local-development.md](local-development.md), [known-gaps.md](known-gaps.md)

**12a. What are my.finternetlab.io, sanctum.finternetlab.io and foundry.finternetlab.io?**
They're the **Finternet web portals** (the end-user and developer web app) for production, staging/sandbox and dev. In a portal you sign up or log in, see your tokens and transactions, transfer, run KYC to get a credential, link wallets, and use **API Access** to create API clients and developer tokens. Your code doesn't call the portal; it calls the matching **API host**: `units.finternetlab.io`, `units.sanctum.finternetlab.io` or `units.foundry.finternetlab.io`. → [portals-and-access.md](portals-and-access.md)

**12b. Can I use the same account and developer token on sanctum and production?**
No. Accounts, API clients, token classes and tokens are all per environment. Sign up on `my.finternetlab.io` (Google SSO) and register new clients there before going live. → [portals-and-access.md](portals-and-access.md) §7

**12c. I lost my client secret / developer token. Can I see it again?**
No, it's shown once. In the portal, open **API Access → your client → Rotate secret**. Set grace seconds so the old token keeps working while you redeploy. → [portals-and-access.md](portals-and-access.md) §5

**13. Is there an SDK?**
No official SDK has been published. Write a thin envelope client (about 50 lines): POST JSON, add `context`, check `ok = 2xx && context.status != "failed"`, and read `response`. → [integration-playbook.md](integration-playbook.md), [worked-examples.md](worked-examples.md)

**14. What credentials does a call need?**
- `context.developerToken` on every call. It identifies your app or service account.
- `context.authorization: "Bearer <user JWT>"` for almost everything that acts as a user (mint, transact, reads, class registration). Not needed for the login calls, `/account/refresh`, or sessionless `/token/add`.
- `signature: {keyId, jws}` on `/v1/token/transact` when signature verification is on.

All of these go **in the JSON body**. The `Authorization:` HTTP header is not read. → [auth-and-onboarding.md](auth-and-onboarding.md)

**15. How do users log in?**
Login is OTP-based:
```json
POST /v1/account/login  {"context":{...ctx,"id":"api.account.login"},"payload":{"username":"alice@example.com"}}
POST /v1/account/login  {"context":{...},"payload":{"username":"alice@example.com","otp":"123456"}}
→ response {accessToken, tokenType, expiresIn, refreshToken?, refreshExpiresIn?, isExisting}
```
`username` is an email or E.164 phone number. The fixed OTP `123456` works on non-prod only. If `isExisting:false`, the returned token is an **OTP JWT** that can only be used on `/v1/account/create`. → [auth-and-onboarding.md](auth-and-onboarding.md)

**16. How do I create an account?**
```json
POST /v1/account/create
{"context":{...ctx,"id":"api.account.create","authorization":"Bearer <OTP JWT>"},
 "payload":{"address":"acme-ops","name":"Acme Operations","entityType":"BUSINESS"}}
```
`address` must match `^[a-z0-9._-]+$`. `name` is letters and spaces only. `entityType` is `PERSONAL` or `BUSINESS`; the docs' "individual" is stale. The response contains real session tokens. **Store the plaintext address and `sha256(lower(trim(address)))` now**, because `/account/get` masks the address later. → [auth-and-onboarding.md](auth-and-onboarding.md)

**17. How long do sessions last, and how do I refresh?**
The access token lasts about 10 h (`expiresIn` 36000). The refresh token idles out after 30 min and is **single-use**. Call `POST /v1/account/refresh {"refreshToken":"..."}` on a timer comfortably under 30 min, behind a single-flight lock. Two concurrent refreshes destroy the session (`SESSION_REVOKED`), and the user must log in with OTP again. → [auth-and-onboarding.md](auth-and-onboarding.md)

**18. What's an operator account?**
It's an ordinary UNITS user account that your organisation owns, such as `acme-registry`. You use it for all class registration and platform-level writes (mint, transact). Whoever registers a class owns it and is its issuer, so using one operator account avoids `FORBIDDEN` errors when different people act on the same class. End users keep their own accounts and own their credentials. For production, ask the platform team about a non-OTP path for keeping the operator session alive. → [integration-playbook.md](integration-playbook.md)

**19. What's the difference between the developer token and the user JWT?**
The developer token identifies **your application**: scopes, rate tier and allowed operations, resolved at the central registry. The user JWT identifies **the person or org acting**, and resource authorization (OPA) is evaluated against that account's identity on the token. → [auth-and-onboarding.md](auth-and-onboarding.md)

**20. What are scopes?**
Scopes are permissions held by your API client, in the form `entity:action` with `view|create|manage` (plus `tokens:transact`). Examples: `tokens:view`, `tokens:create` (mint/add), `tokens:transact`, `tokenClasses:create`, `tokenClassConfigs:create`, `keys:create`, `accounts:manage` (login/refresh), `delegations:view`, `workflows:create` (delegations), `clients:view`. Wildcards are `tokens:*` and `*`. The registry catalogue is authoritative (`POST /v1/scopes/search`). The public docs' "15 scopes" and "27 scopes" counts are both stale. A missing scope returns `403 CLIENT_INSUFFICIENT_SCOPE`. → [auth-and-onboarding.md](auth-and-onboarding.md)

**21. How do I rotate my developer token?**
`POST /v1/clients/rotate-secret {"clientId":"...","graceSeconds":3600}`. The new token is returned once, and the old one stays valid for the grace period. On some builds this API id is unmapped and returns 500 `SCOPE_MAPPING_NOT_CONFIGURED`. If so, ask the platform team. → [auth-and-onboarding.md](auth-and-onboarding.md)

**22. Can I call UNITS from a browser?**
Don't. The developer token is a secret. Call UNITS from your backend (a BFF) and keep the token server-side. → [integration-playbook.md](integration-playbook.md)

---

## C. Identity and addresses

**23. What identifies a user on tokens?**
`sha256(lower(trim(address)))` as lowercase hex with no `0x`. It equals the JWT `preferred_username`. It is **not** the DID. The DID is `did:units:0x<ed25519 pubkey hex>` and is unrelated to the hash. → [concepts.md](concepts.md)

**24. When do I send the plaintext address and when the hash?**
- Plaintext: `transact.to`, delegation `grantee_address`, class `identities[].id`, `/clients/register identities[].address`, `/address/*`.
- Hash: `/v1/token/add` `owner` (sessionless) and the `credentialSubject.id` convention.

→ [auth-and-onboarding.md](auth-and-onboarding.md)

**25. I lost a user's hash. How do I get it back?**
Through the API you can't: `/account/get` masks the address. The hash is `sha256` of the plaintext address. If you know the address, recompute it. If you only know the email, ask the user to log in and read `preferred_username` from their JWT. → [troubleshooting.md](troubleshooting.md)

**26. How do I resolve a DID or address?**
Use `POST /v1/address/resolve`. `GET /v1/did/:address` is disabled. → [api-reference.md](api-reference.md)

**27. Should I put `identities[]` on mint?**
**No.** The engine fills in issuer, creator and owner from the caller automatically. A hand-written array replaces that, the ids are re-hashed, and the caller loses rights (`FORBIDDEN: no_matching_allow_rule` on the next transact). Put relationship info such as borrower or lender in `data`, and grant access with delegations. → [troubleshooting.md](troubleshooting.md)

---

## D. Token classes and setup

**28. How do I set up a new token type?**
There are two synchronous calls, made as your operator:
```json
POST /v1/tokenclass/register
{"context":{...},"payload":{"tokenClass":"ACME-PTS","tokenStandard":"UNITS-FT","name":"Acme Points",
 "description":"Loyalty points","schema":{},"metadata":{"decimals":2,"symbol":"APT","fungible":true,"transferable":true}}}
→ response.id  (tokenClassId)
POST /v1/tokenclassconfig/register
{"context":{...},"payload":{"tokenClass":"ACME-PTS","tokenClassId":"<id>","programId":"fungible","preHooks":[],"postHooks":[]}}
```
Check with `/tokenclass/get` and `/tokenclassconfig/get` first so the setup is idempotent. → [token-classes.md](token-classes.md), [worked-examples.md](worked-examples.md)

**29. Can I use the seeded classes (USDC, NFH-T, CREDENTIAL, LOAN-NFT…)?**
Only the class owner or issuer can mint or transact on them, so integrators normally register their own. Seeded classes are useful as references: `/tokenclassconfig/get {"tokenClass":"LOAN-NFT"}` shows the real program id. → [token-classes.md](token-classes.md)

**30. My class name is taken. Why?**
Class keys are global across tenants and stored upper-cased. Namespace them, for example `ACME-LOAN-2026`. → [token-classes.md](token-classes.md)

**31. Is the class `schema` enforced?**
No. It is documentation only. Programs validate their own payload structs. Validate `data` against your schema client-side. → [known-gaps.md](known-gaps.md)

**32. Who can mint a class?**
The identities of type `issuer` on the class. If you leave `identities` out or send `identities: []` at registration, the registering caller is stamped owner and issuer. A class whose *stored* identities are `[]` (for example one later set to `[]` via `/tokenclass/update`) is open for minting by any authenticated user, so don't update identities to `[]`. → [token-classes.md](token-classes.md)

**33. How do I cap supply or enforce a minimum balance?**
Set `metadata.maxSupply` / `metadata.minBalance` on the class, and add hooks to the config, for example `"preHooks":[{"hookId":"max-supply","priority":10,"enabled":true,"operations":["mint"]},{"hookId":"min-balance","priority":20,"enabled":true}]` (no `operations` list = the hook's own set: transfer, burn, lock, debit; listing them explicitly is equivalent). Violations fail asynchronously with `MAX_SUPPLY_EXCEEDED` / `MIN_BALANCE_VIOLATED`. Caveats: `maxSupply` is checked per issuer token (the class cap only while you're the sole issuer); the floor applies to every holder including your treasury; and once `minBalance` is set (even `"0"`), every burn and lock must carry `value`. → [token-classes.md](token-classes.md) §6.2

**34. Can I block an operation such as transfer on my class?**
`operationOverrides` is stored but **not enforced**. Use a program or flag that refuses it (`metadata.transferable:false` where the program honours it, or a non-transferable program such as credential), or enforce it in your app. → [known-gaps.md](known-gaps.md)

---

## E. Writing tokens

**35. How do I mint?**
```json
POST /v1/token/mint
{"context":{...ctx,"id":"api.token.mint","valueFormat":"raw"},
 "payload":{"tokenClass":"ACME-PTS","initialSupply":"100000","metadata":{"name":"Acme Points float"},
            "data":{"programRef":"Q4-2026"}}}
→ 200 {"response":{"txId":"0199…","status":"submitted","message":"…","estimatedCompletionTime":"…"}}
```
A user JWT is required, and the caller must be an issuer. Don't send `identities`. NFTs and loans use `"initialSupply":"1"`. → [api-reference.md](api-reference.md)

**36. How do I know my mint succeeded?**
`submitted` only means the request was accepted. Poll:
```json
POST /v1/transaction/status {"context":{...},"payload":{"txId":"0199…"}}
→ {"response":{"txId":"…","status":"completed|failed|…","error":{"code","message"}?}}
```
Poll every ~1 s with backoff until the status is no longer `submitted|pending|processing|executing`, with a timeout of a few minutes. Only `completed` is success. → [integration-playbook.md](integration-playbook.md)

**37. Why don't I get the tokenId back?**
Writes are asynchronous: the API returns before the engine creates the token. After `completed`, call `POST /v1/transaction/get {"txId"}` and read `response.metadata.token_id`, then `metadata.affectedTokenIds[0]`, then the legacy `responseData.tokenId` / `.id` (order explained in `api-reference.md` §5.5.2). As a fallback, use `/v1/token/search` filtered by your own business id, for example `{"filters":{"data.programRef":"Q4-2026"}}`. → [worked-examples.md](worked-examples.md)

**38. Are there webhooks?**
No. There are no webhooks, SSE or websockets. Your integration owns the poll loops. For incremental sync, page `/v1/token/transactions` with `dateRange`. → [known-gaps.md](known-gaps.md)

**39. How do I transfer tokens?**
```json
POST /v1/token/transact
{"context":{...ctx,"id":"api.token.transact","valueFormat":"raw"},
 "payload":{"operation":"transfer","tokenId":"<uuid>","to":"bob","value":"2500"},
 "signature":{"keyId":"<sender ed25519 key id>","jws":"<b64 Ed25519 over JCS(payload)>"}}
→ 202 {"response":{"txId":"…","status":"submitted","workflowInstanceId":"…"}}
```
`to` is the recipient's **plaintext** address. NFTs need `"value":"1"`. Credentials, loans and pools can't be transferred. Under the hood a saga runs Lock → CreateIncoming → CommitDebit → CommitCredit. Track it with `/transaction/status`, or with `/v1/transactions/status {"txn_id"}` for saga detail. Note that on sanctum (Aug 2026), fungible transfers failed with `recipient_address_not_found`, an open issue. → [api-reference.md](api-reference.md), [known-gaps.md](known-gaps.md)

**40. Is there a /token/burn or /token/transfer endpoint?**
No. Everything after mint is `/v1/token/transact` with an `operation`: `transfer`, `burn`, `freeze`, `unfreeze`, `lock`, `unlock`, `update`, `revoke`, `suspend`, `resume`, or domain operations such as `loan_disbursed`. → [api-reference.md](api-reference.md)

**41. Burn / freeze / lock examples?**
```json
{"operation":"burn","tokenId":"…","value":"10","reason":"redemption"}
{"operation":"freeze","tokenId":"…","reason":"compliance hold","frozenBy":"acme-ops"}
{"operation":"lock","tokenId":"…","value":"100","lockedBy":"escrow","lockUntil":"2026-12-31T00:00:00Z"}
{"operation":"update","tokenId":"…","metadata":{"name":"New name"}}      // fungible only; scope tokens:transact, resource action manage
```
The amount field is `value`, not `amount`. → [api-reference.md](api-reference.md)

**42. How do amounts and decimals work?**
Amounts are always **strings**: u128 in the engine, `big.Int` in the API, never floats. Set `context.valueFormat` explicitly on `/token/get`, `/token/search`, `/token/mint` and `/token/transact` (and only there; other closed contexts reject it):
- `"raw"`: base-unit integers (`"250050"` = 2500.50 with decimals 2).
- `"display"`: decimal strings, converted using the class `metadata.decimals`.

The code default is `display`, but the schema text says raw, so always send it explicitly. Digits beyond `decimals` are silently truncated, and zero is accepted on plain FT, so validate client-side. → [concepts.md](concepts.md)

**43. How do I sign `/token/transact`?**
1. Make sure the session user has an active **ed25519** key. Create a custodial one with `/v1/account/keys/create`, or register your own with `/v1/account/keys/register`. Get its id (`keyId`) from `/v1/account/keys/search`.
2. Canonicalise `payload` with RFC 8785 JCS.
3. Sign the canonical bytes with Ed25519 and **std-base64** the raw 64-byte signature. That is `jws`, even though it is not a compact JWS.
4. Send `"signature":{"keyId":"…","jws":"…"}` at the top level, beside `context` and `payload`.

Custodial users can use OTP-gated `/v1/account/sign` instead. Signature enforcement is environment-dependent; always build signing in. → [auth-and-onboarding.md](auth-and-onboarding.md)

**44. Is there idempotency? What happens if I retry?**
There is no idempotency key. Every POST to mint or add is a new write. Always use a fresh `msgId` per attempt. Before re-submitting after a timeout, search by your business id to check whether the first attempt landed. Treat a duplicate-credential failure ("Credential already exists", seen at poll time) as success. → [integration-playbook.md](integration-playbook.md)

**45. Can I write without a user session (pure B2B)?**
Only `/v1/token/add` is designed for that (sessionless credential issuance with `owner` = hash). `/token/get`, `/token/transact` and `/tokenclass/register` can accept SA-only calls when your client's registry record carries an owner address. Most integrations still use an operator session. → [auth-and-onboarding.md](auth-and-onboarding.md)

**46. What order should dependent writes go in?**
Submit the next write only after the previous one is `completed`, because there is no per-token ordering guarantee. For example: originate the loan, wait, then record the lien, then disburse. Compensate in your app if a later step fails. → [integration-playbook.md](integration-playbook.md)

---

## F. Use cases

**47. How do I issue a KYC credential?**
Bind a `credential` class (`tokenStandard` `UNITS-CREDENTIAL`), then call `/token/add`. You need only the developer token, with no user JWT:
```json
POST /v1/token/add
{"context":{...ctx,"id":"api.token.add"},   // no authorization
 "payload":{"tokenClass":"ACME-KYC","owner":"<sha256 of user's address>",
  "credential":{"@context":["https://www.w3.org/ns/credentials/v2"],"type":["VerifiableCredential","KYCCredential"],
   "issuer":"did:units:0x…","validFrom":"2026-10-03T00:00:00Z","validUntil":"2027-10-03T00:00:00Z",
   "credentialSubject":{"id":"<user hash>","documentType":"PASSPORT","country":"IN",
                        "faceMatchVerified":true,"faceMatchPercentage":"97.5"},
   "evidence":[{"type":["DocumentVerification"],"rawPayload":{"providerRef":"KYC-123"}}]},
  "metadata":{"name":"Acme KYC","tokenStandard":"UNITS-CREDENTIAL"}}}
```
`credentialSubject` has a closed KYC shape (`id, documentType, country, faceMatchVerified, faceMatchPercentage` are required). Put any other domain data in `evidence[].rawPayload`. Poll with the **owner's** session. Revoke with `/token/transact {"operation":"revoke","tokenId":"…","data":{"reason":"Document expired"}}`, using the holder's session or a `transact` delegation from the holder: the holder is stamped owner **and** issuer and you get no identity. Verifiers should validate credential provenance (expected token class, VC `issuer`, provider signature/evidence, and confirmation from the issuing provider) rather than relying on class membership alone (`token-programs.md` §6.3). → [worked-examples.md](worked-examples.md)

**48. Can a credential be transferred or burned?**
No. Credentials are soulbound. The only operations are `add` (via /token/add), `suspend` (`active`→`frozen`), `resume` (`frozen`→`active`) and `revoke` (terminal, `burned`). Nothing expires automatically: `validUntil` and `suspendUntil` are informational. → [token-programs.md](token-programs.md)

**49. How do I represent a loan?**
Register a class with `tokenStandard:"UNITS-Loan"` bound to `loan-nft-program`. Mint it with `initialSupply:"1"` and a `LoanOriginatedPayload` in `data`. Keys are camelCase. u128 money fields are integer strings in minor units. u32 fields (tenure, emiDay, tranche) are JSON numbers. Send `foir` as `"1"`. Then call domain operations through `/token/transact`:
```json
{"operation":"cersai_registered","tokenId":"…","data":{"regNumber":"CERSAI-1","cersaiDate":"2026-10-03"}}
{"operation":"loan_disbursed","tokenId":"…","data":{"tranche":1,"value":"5000000","date":"2026-10-03","txId":"UTR123",
  "newDisbursementAmount":"5000000","newPrincipalOutstanding":"5000000","newDisbursementStatus":"Full"}}
```
Other operations include `payment_received`, `dpd_change`, `charge_levied` and `loan_closed`. Field names follow the program structs, and loan amount fields are named `value` in current code (token-runtime refactor #220 "amount→value"). Older builds, such as sanctum in Aug 2026, expected `amount`, so if `/transaction/status` reports a missing field `amount`, resend using `amount`. `newDisbursementStatus` is `NotStarted|Partial|Full`. Pools use `loan-pool-nft-program`, whose keys are snake_case. → [token-programs.md](token-programs.md), [worked-examples.md](worked-examples.md)

**50. How do I record collateral or a lien?**
There is no generic asset/lien program yet. Today, record the lien as `cersai_registered` on the loan token, or ask Finternet for an asset program (`asset_registered/lien_marked/lien_released`). A credential can't carry a lien. → [known-gaps.md](known-gaps.md)

**51. How do I do vouchers / purpose-bound money?**
`purpose-bound-voucher` (UNITS-SFT) can't be minted on current builds (`CAPABILITY_DENIED`). Use a `fungible` class and enforce category and merchant rules in your app until that is fixed. → [known-gaps.md](known-gaps.md)

**52. How do I bring an on-chain stablecoin balance in?**
Use a PROXY-FT class whose `metadata.contractIds` maps CAIP-2 to the contract (bound to `stables`), and register the user's wallet as a key. Then:
```json
POST /v1/token/add {"payload":{"tokenClass":"USDC","chainId":"eip155:8453","contractAddress":"0x…","walletAddress":"0x…","value":"25000000"}}
```
Calling it again with the owner's session reconciles the balance. → [token-classes.md](token-classes.md)

**53. How do I give a third party (auditor, lender) read access?**
Create a delegation as the token owner:
```json
POST /v1/workflows/execute
{"context":{...ctx,"id":"api.workflow.execute"},
 "payload":{"workflow":"delegation-create","action":"allow",
  "data":{"grantee_address":"auditor-co","label":"tokens:id:<tokenId>","permission":"view","expires_at":"2027-01-01T00:00:00Z"}}}
```
Labels: `tokens:id:<uuid>`, `tokens:tokenclass:<CLASS>`, `tokens:*`, `tokens:tokenclass.metadata.status:active`. Permissions are `view|transact|manage` and don't imply each other. A non-owner request becomes `pending` until the owner approves it. Revoke with `{"workflow":"delegation-revoke","action":"revoke","data":{"delegation_id":"…"}}`. List with `/v1/delegations/list {"filter":"granted_by_me"}` and check with `/v1/delegations/check {"tokenId"}`. → [workflows-and-services.md](workflows-and-services.md)

**54. Can a delegation limit amounts or frequency?**
No. A delegation has only a label, a permission, allow/deny, an optional expiry and optional `allowedOperations` (dot-path value rules). → [workflows-and-services.md](workflows-and-services.md)

---

## G. Reading, proofs and data

**55. How do I read tokens?**
`/v1/token/get {"tokenId"}` returns 403 unless you are an identity on the token or hold a delegation. `/v1/token/search {filters, pagination{limit≤1000, offset}, sortBy}` supports dot-path filters (`data.x`, `metadata.y`) and `groupBy:["tokenClass"]` with sums, and only returns tokens where you are an identity. `/v1/token/transactions {"filters":{"tokenId","dateRange"}}` gives per-token history. `/v1/transaction/get|search` gives transaction records. → [api-reference.md](api-reference.md)

**56. How do proofs work?**
There are two layers:
1. **Per-token state commitment (live).** Every write computes `commitment[n] = H(commitment[n-1], tx, timestamp, state…)` (SHA-256 by default, BLAKE3 configurable). It is verified before every operation, so a broken chain blocks writes. It is returned on token reads.
2. **Merkle batch proof.** Completed transactions are batched into a BLAKE3 Merkle tree once a full batch accumulates. `POST /v1/transaction/proof {"txId"}` returns `merkleRoot`, `leafHash`, `proofPath` and `proofStatus`. It is often `pending`.

`/proof/leaf` returns the leaf data so you can recompute it. `/proof/verify` is structural only. No chain anchoring yet. → [concepts.md](concepts.md)

**57. Can I verify a proof independently?**
Yes, for Merkle batches. Fetch `/v1/transaction/proof/leaf`, BLAKE3-hash the compact sorted-key JSON (timestamps normalised to microseconds), and compare it with `leafHash`. Then walk `proofPath` (`left` gives `blake3(hash‖current)`, otherwise `blake3(current‖hash)`) and compare the result with `merkleRoot`. → [concepts.md](concepts.md)

**58. Is data encrypted?**
Traffic uses TLS. Keep raw PII out of token `data` and store hashes or references instead. Don't make claims about encryption at rest to your users; confirm current guarantees with Finternet. → [known-gaps.md](known-gaps.md)

**59. Is the ledger immutable?**
It is tamper-evident (hash-chained state commitments). `update` can overwrite `data`. Say "tamper-evident", not "immutable", and don't make claims about audit immutability without confirming current guarantees with Finternet. → [known-gaps.md](known-gaps.md)

**60. Can I query state "as of" a past date?**
Not through the API. Engineers can query `state_history` (a full snapshot per version). Keep business-effective dates in `data`. → [known-gaps.md](known-gaps.md)

---

## H. Errors and operations

**61. My mint returned `submitted` but status says `failed: UNSUPPORTED_TOKEN_STANDARD`.**
The class `tokenStandard` isn't on the bound program's whitelist. The match is exact (for example `credential` takes `UNITS-CREDENTIAL`). Fix the class or config. → [troubleshooting.md](troubleshooting.md)

**62. Every operation fails `primitive_capability_missing`.**
You registered the class but not the class config. Call `/v1/tokenclassconfig/register`. → [troubleshooting.md](troubleshooting.md)

**63. `FORBIDDEN: no_matching_allow_rule` on transact after a successful mint.**
Either you sent `identities[]` on mint, or you're acting from a different account than the one that minted. Re-mint without identities from the operator account. The bad token can't be deleted; mark it void in your system (it won't show in your searches, since you're not an identity on it) and ask Finternet if it needs platform-level cleanup. → [troubleshooting.md](troubleshooting.md) A.3

**64. `500 SCOPE_MAPPING_NOT_CONFIGURED`?**
The platform's scope catalogue lacks this API id. You can't fix it client-side, so report it to the platform team. → [troubleshooting.md](troubleshooting.md)

**65. 503 "registry service unavailable"?**
The central registry or a dependency is down, and auth fails closed. Retry with backoff. On the sandbox, check that you are inside ~08:00–21:00 IST on a weekday. → [troubleshooting.md](troubleshooting.md)

**66. A transfer shows `STUCK`.**
The saga passed the point of no return and the destination outcome is unknown. **Don't retry.** Escalate with the txId, and an operator will resolve it manually. → [troubleshooting.md](troubleshooting.md)

**67. Rate limits?**
Limits are set per client tier × scope, enforced at the registry. You get `429 TOO_MANY_REQUESTS` with `Retry-After`. Poll at ~1/s per tx, with backoff. → [api-reference.md](api-reference.md)

**68. What should I include in a bug report?**
Environment, endpoint, redacted request and response, `msgId`, `X-Correlation-ID`, `txId`, timestamps, and the `error.code`/`message`. Never include your developer token or JWTs. → [troubleshooting.md](troubleshooting.md)

**69. The public docs say X but the API does Y. Which is right?**
Trust behaviour on the live instance first, then current code. The public docs have known stale claims: header auth, old program ids, `/v1/api-clients`, `entityType: individual`, identities on mint, anchoring status, and `GET /v1/did`. See the truth table in [troubleshooting.md](troubleshooting.md) §E.

---

## I. Engineers

**70. How do I run UNITS locally?**
Use the units-api docker compose stack (Keycloak 26.5.6 realm `finternet` on :8080, Postgres 17, Vault, MinIO, Kafka, Restate), with units-api on `http://localhost:3000` and Swagger at `/v1/docs/`. On macOS arm64, build with `CGO_ENABLED=0`. Don't run `docker compose down -v` against a shared stack, because e2e `TestMain` wipes volumes. → [local-development.md](local-development.md)

**71. Can I publish directly to Kafka to test the engine?**
No. The engine rejects state-mutating messages without federation context (`opSeq`/`callerInstance`/`requestEnvelope` plus a `primitive_ops` row). Go through units-api. Old scripts (`test-kafka-produce.sh`) are stale. → [workflows-and-services.md](workflows-and-services.md)

**72. Where do I look when a tx is stuck?**
Look at `transactions` (status, status_v2, error), then `primitive_ops` (engine_status, completion_status), then `token_transactions` / `state_history`, then the Restate `PrimitiveOperationWorkflow/<txId>`, then the Kafka DLQ `units.token.operations.dlq`. The full procedure is in [troubleshooting.md](troubleshooting.md) §D.2.

**73. How is a new program added?**
Implement the `TokenProgram` trait (pure logic, no I/O), declare the supported standards, operations and primitive capabilities (include DomainLifecycle if it must be mintable), register it in `ProgramRegistry`, and ship an engine release. The engine self-registers it into `token_programs` at boot. Start from `hello-token`. → [authoring-token-programs.md](authoring-token-programs.md)

**74. What's the transaction status vocabulary?**
`/transaction/status`: `submitted → pending → processing → completed | failed | cancelled`, plus `awaiting_signature`. `/transactions/status` (saga): `SUBMITTED → PREPARED → COMMITTING → COMMITTED`, plus `ABORTED`, `AUTO_REVERSING`, `REVERSED` and `STUCK`. Proofs: `pending | proven | anchored`; anchored never happens today. → [workflows-and-services.md](workflows-and-services.md)
