# UNITS known gaps, limitations and roadmap status

Snapshot: **2026-10-03**. Status values come from code inspection and live integration testing against sanctum (Aug 2026). Things change, so re-check against the live instance before you design around a gap. When you tell an end customer about a gap, describe it the way the "How to talk about it" guidance in §10 does.

Related: [troubleshooting.md](troubleshooting.md) (symptoms and fixes) · [faq.md](faq.md) · [integration-playbook.md](integration-playbook.md) · [token-programs.md](token-programs.md) · [authoring-token-programs.md](authoring-token-programs.md)

> **Source snapshot.** Code-level claims were checked against **units-api 2026-09-17 (`29ac16f`)** and **units-token-runtime 2026-07-07 (`86227c4`)**. The runtime checkout is behind what is deployed. In these checkouts the `fungible` program's capability preset (`fungible_balance`) has no `DomainLifecycle`, while units-api routes every mint (and non-transfer transacts such as burn and freeze) through the `domain_lifecycle` template (`StartDomainLifecycle`, method `DomainLifecycle`). Read literally, fungible mint would fail with `CAPABILITY_DENIED`, yet fungible mint worked live on sanctum in Aug 2026, so the deployed runtimes are newer. Where the code and live behaviour disagree, trust live behaviour on your instance and verify with a test transaction polled to completion.

Status legend: **Open** (no fix in code) · **Designed** (design or proposal exists, no code) · **Partial** · **Env** (environment-dependent) · **Behaviour** (by design; document it, don't fix it) · **Fixed**.

---

## 1. Top 12 integrators hit first

| # | Gap | Impact on you | Workaround |
|---|---|---|---|
| 1 | No webhooks, SSE or websockets | You never get a push when a write finishes. | Run your own poll loop on `/v1/transaction/status`: start at ~1 s, back off, set a timeout, and never report success on the 202. |
| 2 | Mint doesn't return a tokenId | You need a second lookup. | `/v1/transaction/get` gives `metadata.token_id` (units-api stamp on completion) or `metadata.affectedTokenIds` (engine); `responseData.tokenId` only on older builds and proxy flows. As a fallback, `/v1/token/search` on your business id in `data.*`. |
| 3 | No idempotency key | A retry after a timeout can mint twice. | Keep your own business id. Search before you re-submit. Use a fresh `msgId` per attempt (it's for logging only). |
| 4 | API client registration *via the API* needs a superadmin | You can't call `/v1/clients/register` with your own token. | Self-serve through the web portal's **API Access** page (`sanctum.` / `my.finternetlab.io`). See portals-and-access.md. |
| 5 | Custom token programs can't be deployed by integrators | You must fit a stock program (fungible, non-fungible, credential, stables, loan, loan-pool). | Ask Finternet engineering for a new program. Expect days of work per program plus an engine release. |
| 6 | `purpose-bound-voucher` isn't mintable | Voucher mint/issue/redeem fail `CAPABILITY_DENIED`. | Enforce purpose-spend off-ledger, or use a `fungible` class plus app-side category rules. |
| 7 | Fungible transfer recipient resolution failed on sanctum (Aug 2026) | `transfer` returned `recipient_address_not_found` for every recipient. | Make sure the recipient exists and has a registered key (`/v1/account/keys/register`). Otherwise escalate, because it's an open issue. |
| 8 | Class `schema` isn't enforced | Bad `data` is accepted. | Validate client-side. Programs validate their own structs. |
| 9 | Sending `identities[]` on mint breaks authz | Later transacts fail `FORBIDDEN no_matching_allow_rule`. | Never send identities on mint. Use one operator account. |
| 10 | Merkle proofs often `pending`, no chain anchoring yet | A proof may not exist for hours or days. | Use the per-token state commitment chain. Describe it as "hash-chained, tamper-evident". Anchoring is on the roadmap. |
| 11 | `valueFormat` defaults to `display` in code | Amounts get mis-scaled by 10^decimals. | Always send `context.valueFormat` on token get/search/mint/transact (other endpoints reject it). |
| 12 | Sandbox availability | Sanctum is available ~08:00–21:00 IST on weekdays. | Test inside the window and plan demos around it. Production may run an older build than sandbox, so re-test environment-dependent behaviour. |

---

## 2. API and authentication

| Gap | Impact on integrators | Workaround | Status |
|---|---|---|---|
| Client registration via the API requires a superadmin SA ("interim governance"). Protected scopes need superadmin approval. | Only the portal can self-serve. | Use the portal's API Access page, or have the platform team register the client and hand over the developer token once. | Open (interim) |
| Several api ids have no scope-catalogue mapping: `clients.rotate_secret`, `clients.reactivate`, `clients.scopes.update`, `users.scopes.*`, `registry.forwarding.get`, `account.refresh` on some builds | `500 SCOPE_MAPPING_NOT_CONFIGURED` for non-superadmin SAs. | Ask the platform team to run the operation, or to add the mapping. | Open |
| No request-level idempotency key. `msgId` is logging only and `correlation_id` is non-unique. | Retries duplicate writes. | Dedupe on your own business ids. Proposed fix: `context.idempotencyKey` + `UNIQUE(client_id, key)`. | Designed |
| GET endpoints unusable under SA auth (no envelope). | `GET /v1/account/keys`, `/instance/capabilities` and `/registry/forwarding/:did` always return 401. | Use POST equivalents (`/account/keys/search`). | Open |
| Key rotation not implemented | `/v1/account/keys/rotate` returns 501. | Register a new key and remove the old one. | Open |
| Transact signature enforcement is environment-dependent | Some environments may accept unsigned transacts; others require them. | Always implement Ed25519 JCS signing. | Env |
| Refresh tokens are single-use; "Session not active" maps to a generic 401 | Concurrent refreshes end the session (`SESSION_REVOKED`). | Refresh on a timer under 30 min behind a single-flight lock. Re-login on 401. | Phase 1 shipped; follow-ups open |
| Error metadata not returned (FORWARD `api_url`, `program_id`, `capability_gate`) | Harder to self-diagnose. | Quote `msgId` when you report. | Open |
| Sender homed elsewhere shows as generic `CONFLICT`, not `FORWARD` | Confusing error. | Send writes to the home instance. | Open |
| `/v1/registry/lookup-address`: schema needs `chain_id`, code reads `chainId` | The chain filter is always empty. | Avoid it, or expect unfiltered results. | Open |
| No org→member hierarchy | You can't model "employees of Acme" natively. | One operator account per org plus delegations. | Open |
| Some checks are environment-dependent (user-scope gate, consent gate, OIDC session confinement) | Behaviour differs per environment. | Handle `USER_INSUFFICIENT_SCOPE` / `TERMS_CONSENT_REQUIRED` anyway. | Env |
| No endpoint reveals the sha256 identity hash of an existing account. `/account/get` masks the address. | You can't `token/add` to users whose address you didn't record. | Record the plaintext address and `sha256(lower(trim(address)))` at signup. Check the hash equals the JWT `preferred_username`. | Behaviour |

## 3. Tokens and programs

| Gap | Impact | Workaround | Status |
|---|---|---|---|
| Programs are compiled into the engine binary. External teams can't ship one, and there's no WASM/self-serve. | You can only choose among stock programs. | Ask Finternet engineering. Roadmap: "Dynamic Loading of Token Programs" (WASM, design phase) and a kernel/guest proposal with a stock `domain-lifecycle` guest. | Designed |
| `/v1/tokenprogram/register` can create a row but can't make an operation executable | Registering your own program id appears to work, then ops fail. | Bind to a live program id only. | Behaviour |
| `purpose-bound-voucher`: no DomainLifecycle capability | mint/issue/redeem/revoke return `CAPABILITY_DENIED`. A voucher only appears by receiving a federated transfer. | Use fungible + app rules. | Open |
| No generic asset/lien program (`asset_registered / lien_marked / lien_released`) | You can't mint a standalone collateral token with a lien lifecycle. | Record the lien as `cersai_registered` on LOAN-NFT, or request a program (for example a warehouse-receipt or asset program). | Open (to build) |
| Fungible tokens have no batch identity: mints and credits merge into the owner's oldest token of the class | You can't keep lot or batch provenance through transfers. | Use NFT-style classes, or one class + config per batch (not recommended). A `BATCH-SFT` program has been proposed. | Open, needs product decision |
| Class `schema` never enforced | Any JSON is accepted in `data`. | Validate client-side. A fix (wire the validator behind a flag) has been proposed. | Open |
| `update` shallow-merges into `data` with no immutable fields | Values can be overwritten by any holder of `manage`. | Keep attestations in credentials. Restrict `manage`. | Open |
| `operationOverrides` stored but not enforced | "Disabled" operations still run. | Enforce them in your app. | Open |
| `HookConfig.config` not passed to hooks. Unknown hookIds silently skipped. Hook `priority()` ignored in places. | Hook parameters don't take effect. | Put limits in class `metadata` (`maxSupply`, `minBalance`). | Open |
| A class whose stored `identities` is `[]` is open for minting by any authenticated user | Updating a class to `[]` opens it. Registering with `[]` is safe because the caller is stamped as owner+issuer. | List explicit issuers, or omit `identities`. Don't `update` identities to `[]`. | Behaviour |
| Zero amounts accepted on plain FT. Fractional digits beyond `decimals` silently truncated. | Silent data errors. | Validate client-side. | Open |
| User-burn accounting is config-dependent: the code only credits the issuer reserve when `additionalStateRequirements` loads the issuer token (see token-programs.md, fungible). Only an issuer burn reduces supply. No `retire` op. | Carbon-style retirement isn't native. | Burn from the issuer, or model retirement as a separate class or credential. | Open |
| CREDENTIAL, LOAN-NFT and LOAN-POOL aren't transferable | No loan sale by transfer. | Domain ops, or a new program. | Behaviour |
| Seeded classes are owned by their seed accounts | You can't mint NFH-T/CREDENTIAL/LOAN-NFT/etc. from your account. | Register your own classes. | Behaviour |
| Mixed-case seeded classes `USDe`, `crvUSD` unreachable (API upper-cases, DB case-sensitive) | Those 2 proxy classes can't be used. | None. | Open |
| Token class key is globally unique across tenants | Name collisions. | Namespace keys (`ACME-...`). | Behaviour |
| Loan programs: trust-payload ops can set any status. Several ops have no status gate. `loan_rescheduled` doesn't update `totalEmis`. | The issuer/operator must supply correct values. | Validate in your servicing system. | Open |
| Loan-pool mint `tokenIdsFrom: payload.loan_token_ids` likely doesn't resolve | The pool mints, but loans get no pool membership claim. | Verify loan state after a pool mint. Engineers: fix the seed to `payload.data.loan_token_ids`. | Open (probable bug) |
| Credential `credentialSubject` is a closed KYC shape | Non-KYC credentials don't fit. | Put domain data in `evidence[].rawPayload`. Use stand-ins for required KYC fields. | Behaviour |
| Credential provenance via `/token/add` | `/token/add` is dev-token-only for sessionless issuance; `owner` is the address hash; the holder is stamped owner and issuer. Poll with the owner's session. Revoke/suspend/resume require the holder's session or a delegation. | Verifiers should validate credential provenance (expected token class, VC `issuer`, provider signature/evidence, and confirmation from the issuing provider) rather than relying on class membership alone. See `token-programs.md` §6.3. | Behaviour |
| Fungible `maxSupply` is checked per issuer token, not class-wide | With several issuers each minter gets its own cap. | Keep one issuer per capped class. | Behaviour |
| Any `metadata.minBalance` (even `"0"`) makes `value` mandatory on burn, lock and debit when the `min-balance` hook covers them | Whole-balance burns and whole-token locks fail `INVALID_PAYLOAD`. The floor also applies to the issuer's treasury. | Always send `value`; omit `minBalance` if you don't need a floor. | Behaviour |
| Loan `data` keys outside `LoanOriginatedPayload` are silently dropped | Collateral details (gold weight, purity, packet id) sent in `data` are lost. | `metadata.tags` at mint, a separate collateral credential/NFT, or your LMS. See `token-programs.md` §9.4.1. | Behaviour |
| Claims and VC proofs (`ClaimProof.jws`) are stored, not verified by the platform. Claim status and expiry unchecked. | Treat claims as assertions. | Verify off-platform, or use credential tokens (revocable). | Open |
| `credential-verification` hook is a presence check only | No checks on issuer trust, freshness or scores. | Add checks in your app. | Partial |
| No time-driven operations (expiry, maturity, coupons, auto-resume) | Nothing changes because time passed. | Run your own scheduler/sweeper that calls transact. On the roadmap. | Open |
| No transformation (N inputs → M outputs) or lineage graph. `source_token_id` not persisted on credit. | You can't model processing or blending chains. | Keep lineage in your system. | Open |
| No business-effective timestamp / as-of API | You can't query state as of a date via the API. | Engineers can query `state_history`. Keep effective dates in `data`. | Open |
| Tenant scoping by any identity, so the issuer keeps visibility of tokens after sale | Privacy. | Don't promise post-sale invisibility. | Open |
| Offset pagination (max 1000), no cursor or change feed | Large syncs can skip or duplicate rows. | Page by `createdAt` windows and dedupe. | Open |
| No DvP `settle` op / `/v1/settlement` | No atomic asset-vs-cash settlement. | Two separate transfers with app-level compensation. Designed on the roadmap. | Designed |
| No netting, ISO 20022, statements, encumbrance semantics (pledge ≠ freeze) | Capital-markets features are missing. | Out of scope today. | Open |
| No smart contracts. ERC-20/721/3643 are program selectors only. | Not ERC-compliant on-chain tokens. | Say "ERC-style semantics", never "ERC-compliant". | Behaviour |
| `is_fungible` defaults to true when class `metadata.fungible` is missing | NFT-like classes behave fungibly (merge). | Always set `metadata.fungible` explicitly. | Open |

## 4. Proofs, anchoring, integrity and data protection

| Gap | Impact | Workaround | Status |
|---|---|---|---|
| Chain anchoring not implemented | No public-chain evidence. | Don't claim anchoring. Roadmap "Proof Service" (design). | Open |
| Merkle batches only when a full batch fills (no time flush) | `/transaction/proof` stays `pending`. | Use the state commitment from `token/get`. Expect `pending`. | Open |
| `/transaction/proof/verify` is structural only | No deep verification. | Recompute the leaf hash and Merkle path yourself (BLAKE3). | Open |
| Platform security and compliance guarantees | — | Don't make claims about encryption at rest, anchoring or audit immutability to your users; confirm current guarantees with Finternet. Don't store raw PII in tokens; store hashes or references. | — |
| Concurrent writes to one token | Rare anomalies under load; hot tokens retry. | Serialize writes per token in your app. | Open |
| Post-hook `modified_state` patch can break the commitment chain | Can cause `DATA_INTEGRITY_VIOLATION` on the next op. | Report it if seen. | Open |
| Proxy tokens mirror on-chain balances reported to UNITS | The shadow ledger reflects what callers submit. | Verify on-chain balances yourself. | Open |
| No retention-policy enforcement (DPDPA, PMLA/RBI KYC) | Compliance is on you. | Keep PII off-ledger. | Open |
| No published throughput figures or SLOs | Unknown throughput. | Ask before you plan volume. | Open |

## 5. Eventing

| Gap | Impact | Workaround | Status |
|---|---|---|---|
| No outbound webhooks, event bus or SSE for integrators (Kafka is internal) | Pull-only integration. ERPs must poll. | Poll status, then use `/v1/token/transactions` with `dateRange` for incremental sync. A proposal exists: signed, retried webhooks off the `primitive_ops` outbox. | Open |
| No change feed or cursor | Incremental sync is approximate. | Time-window queries plus dedupe. | Open |

## 6. Federation and transfers

| Gap | Impact | Workaround | Status |
|---|---|---|---|
| Fungible transfer `recipient_address_not_found` on sanctum (Aug 2026) | Transfers blocked. | Recipient key registration; escalate. | Open |
| Unknown destination after point of no return gives `STUCK` | Manual ops needed. | Escalate. Never retry. | Behaviour |
| `incoming[].expiresAt` reservations are never swept | Stale reservations linger. | None. | Open |
| Multi-instance federation isn't available on the sandbox | Cross-instance flows can't be tested on sanctum. | Single-instance testing. | Designed |
| No Beckn adapter | No Beckn BAP/BPP. | Build your own adapter. Map Beckn ids to tokenClass/tokenId and keep your own `(transaction_id, message_id) → txId` store. | Open |
| Public DID resolution disabled (`GET /v1/did/:address`). No call-back-free verification. | Verifiers must call the API. | `POST /v1/address/resolve`. Proof Service on the roadmap. | Open |

## 7. Vouchers and policy hooks not yet available

Purpose-bound vouchers (see §3) can't be minted today, and the policy layer a voucher program would need is not built yet. Missing today:

| # | Capability | UNITS today |
|---|---|---|
| 1 | Declarative eligibility/policy DSL (who/where/what/how much/when, across enrollment, redemption, activation and expiry) | No DSL. Only hook config + metadata (`redeemableCategories`, `category_limits`). |
| 2 | Escrow release on redeem (`escrow-transfer` post-hook) | Referenced in redeem docs, **not implemented**. `stables` not wired, so redemption never moves money. |
| 3 | Backing-asset flow (vouchers minted against escrowed stablecoin) | `stables` can custody, but there is no deposit-to-voucher backing. |
| 4 | Enforcement hooks: escrow-transfer, geofence, time-window, velocity, merchant allow-list | UNITS has logging, validation, max-supply, min-balance, credential-verification (presence only). Settlement `to` is accepted without merchant validation. |
| 5 | Voucher lifecycle ops beyond the basics (activate, delegate, print, claim, expire, claw-back), offline/printed vouchers | Not available. |

Until these exist, enforce purpose, merchant, geography and velocity rules in your application.

## 8. Environments and operations

| Item | Guidance |
|---|---|
| **Sandbox ("sanctum")**: `https://units.sanctum.finternetlab.io`, app `sanctum.finternetlab.io` | The integrator sandbox. Available ~08:00–21:00 IST on weekdays; assume it can be down outside that window. Fixed OTP `123456` works (non-prod only, but send-otp may still email or SMS a real contact). |
| **Dev ("foundry")**: `https://units.foundry.finternetlab.io` | Not a supported integration target. The public docs still say "Foundry"; use sanctum. |
| **Prod**: `https://units.finternetlab.io` (registry `registry.finternetlab.io`, app `my.finternetlab.io`) | Production may run an older build than sandbox, so newer features or fixes (refresh tokens, newer error codes, etc.) may not be there yet. Re-test environment-dependent behaviour. |
| Public docs | Several stale claims (see [troubleshooting.md](troubleshooting.md) §E). Env URLs "to be disclosed". No SDKs published. Use this skill's references. Verify live. |

---

## 9. Consolidated functional gap register (condensed)

| # | Gap | Status |
|---|---|---|
| 1 | FT has no batch identity (merge by owner+class) | Open, needs product decision (BATCH-SFT vs generalise voucher) |
| 2 | Class schema never enforced | Open, fix proposed |
| 3 | `update` overwrites `data` (no immutable fields) | Open |
| 4 | Claims/VC proofs stored, not verified by the platform | Open |
| 5 | No multi-input/output transformation (3 saga recipes only) | Open |
| 6 | No lineage graph; `source_token_id` not persisted | Open |
| 7 | No idempotency key / external-ref uniqueness | Open |
| 8 | No webhooks / event egress | Open |
| 9 | No Beckn adapter | Open (outside UNITS) |
| 10 | No on-chain anchoring | Open (roadmap) |
| 11 | Kafka partition key = txId, no per-token ordering | Open |
| 12 | Programs call `Utc::now()` (non-deterministic replay) | Open |
| 13 | Programs compiled in; no WASM/self-serve | Open (proposal) |
| 14 | No time-driven/scheduled ops | Open (roadmap) |
| 15 | No DvP settle / `/v1/settlement` | Designed |
| 16 | No netting, ISO 20022, statements, encumbrance | Open |
| 17 | No effective timestamp / as-of API | Open |
| 18 | Issuer keeps visibility after sale | Open |
| 19 | Class with stored `identities: []` is open-mint | Behaviour (document) |
| 20 | User burn may credit issuer pool (config-dependent); no retire | Open |
| 21 | Zero FT amounts accepted; silent truncation | Open |
| 22 | Offset pagination ≤1000, no cursor/change feed | Open |
| 23 | DID resolution disabled; Proof Service "upcoming" | Open |
| 24 | Identity hash not discoverable; hand-declared identities break authz | Behaviour (document) |
| 25 | Token-standard mismatch fails async; field-name drift | Behaviour |
| 26 | No retention-policy enforcement | Open |
| 27 | No org→member hierarchy | Open |
| 28 | Refresh-token follow-ups | Phase 1 landed; rest open |
| 29 | No smart contracts; ERC labels are program selectors | Fact |
| 30 | `purpose-bound-voucher` not mintable | Open |
| 31 | Fungible transfer `recipient_address_not_found` (sanctum, Aug 2026) | Open |
| 32 | No generic asset/lien program | Open |
| 33 | Mint returns no tokenId | Open |
| 34 | Client registration via API superadmin-only | Open (interim) |
| 35 | `valueFormat` default mismatch | Open |
| 36 | Unmapped scope api ids | Open |
| 37 | Key rotation 501 | Open |

---

## 10. How to talk about UNITS

**Accurate to say:** DID-backed accounts with OIDC login and revocable, registry-resolved API clients; governed issuance (issuer identity check); quantity-conserving partial transfers through a durable two-phase saga (Lock → CreateIncoming → CommitDebit → CommitCredit) with compensation and an explicit STUCK state; integer-only amounts (u128 / big.Int); a transactional outbox; per-token before/after history and full snapshots with a chained state commitment written in the same DB transaction ("hash-chained, tamper-evident"); multi-token atomic commits (for example loan-pool mint); Ed25519 request signing; policy-based RBAC with per-permission delegations; BLAKE3 Merkle batch proofs; proxy tokens mirroring on-chain balances (CAIP-2).

**Avoid claiming:** ERC-20/721/3643 compliance (say "ERC-style semantics"); on-chain anchoring (roadmap); platform verification of VCs/attestations; an immutable or append-only ledger; enforced class schemas; encryption at rest or other security/compliance guarantees you haven't confirmed with Finternet; external-chain interoperability beyond shadow mirroring; batch provenance through splits; webhooks; production readiness for a given volume without confirming with Finternet.
