# Token programs

A token program is the code that decides what can happen to a token. This file covers what a program is, how the engine selects and runs one, and every program that ships today. For each program it lists the operations and the exact payload an integrator sends, the state transitions, and the errors. It ends with the error catalogue and the answer to "can I write my own program?".

> Snapshot: **2026-10-03**. Sources: units-token-runtime (Rust; local HEAD Jul 2026 plus later notes), units-api HEAD, seeds, and the live sanctum integration (Aug 2026). Precedence: live behaviour, then code, then specs, then docs. **Environment-dependent** means live and code differ, so check your instance. To see the authoritative list of programs, operations and standards, call `POST /v1/tokenprogram/search`.
>
> Companion: `token-classes.md` (how to bind a class to a program). Engineers writing programs should read `authoring-token-programs.md`.

---

## 1. What a program is

### 1.1 Integrator view

- A **token program** is Rust business logic compiled into the UNITS **token engine**. It defines:
  - which **operations** exist (`mint`, `burn`, `loan_disbursed`, `revoke`…)
  - what each operation's **payload** must look like
  - **validation** (status checks, limits, who may act)
  - the **state transition** (balances, status, `data` fields)
- You **choose** a program for your class by setting `programId` in the token class config. You **can't upload, modify or configure program code**. The only per-class levers are hooks and `config` keys (see `token-classes.md` §3).
- Programs are **pure**: `(context, operation, current token state) → new token state(s)`. The engine handles loading, persistence, commitments, hooks, audit and status reporting.
- Every operation is **asynchronous**. The API accepts it (`txId`), and the engine runs the program later. Program errors therefore appear **only** in `POST /v1/transaction/status` under `response.error {code, message}`.

### 1.2 Program catalogue (what's live)

| programId | Standards (exact match on class `tokenStandard`) | Capability preset | Operations an integrator calls | Entry endpoint | Live status |
|---|---|---|---|---|---|
| `fungible` | `UNITS-FT`, `ERC-3643`, `ERC-20` | `fungible_balance` | mint, burn, transfer, freeze, unfreeze, lock, unlock, update | `/token/mint`, `/token/transact` | mint ✔. transfer: `recipient_address_not_found` on sanctum (open) |
| `non-fungible` | `UNITS-NFT`, `ERC-721` | `unique_ownership` | mint, burn, transfer (same instance → `local_transfer`) | `/token/mint`, `/token/transact` | in code; not live-tested |
| `credential` | `UNITS-CREDENTIAL`, `UNITS-SBT`, `W3C-VC-2.0` | `soulbound_credential` | add, revoke, suspend, resume | `/token/add`, `/token/transact` | add ✔ live |
| `stables` | `PROXY-FT` | `proxy_ledger` | import, reconcile, transfer, sign | `/token/add`, `/token/transact` | import ✔ for seeded classes (needs chain adapter) |
| `purpose-bound-voucher` | `UNITS-SFT` | `semi_fungible_policy_bound` | mint, issue, redeem, revoke | `/token/mint`, `/token/transact` | **BLOCKED**: `CAPABILITY_DENIED` |
| `loan-nft-program` | `UNITS-Loan`, `UNITS-NFT`, `UNITS-LOAN` | `domain_lifecycle` | mint (alias of loan_originated) + 21 further domain ops | `/token/mint`, `/token/transact` | ✔ live (mint, cersai_registered, loan_disbursed) |
| `loan-pool-nft-program` | `UNITS-LoanPool`, `UNITS-NFT`, `UNITS-LOANPOOL` | `domain_lifecycle` | mint + 7 pool ops | `/token/mint`, `/token/transact` | in code; not live-tested |
| `hello-token` | `UNITS-HELLO` | `domain_lifecycle` | mint, update_greeting | — | example for program authors |

Old names you may still see: `reference-ft` → `fungible`, `reference-nft` → `non-fungible`, `reference-credential` → `credential`, `nfh-voucher` → `purpose-bound-voucher`, `loan-nft` → `loan-nft-program`. The DB seed rows for `token_programs` are **stale**. For example, the seed for `credential` lists `issue`/`update_status` and the seed for `loan-nft-program` lacks `mint`. The engine overwrites these rows at boot (self-registration), so always trust `/v1/tokenprogram/search` on the live instance.

---

## 2. How an operation reaches a program

### 2.1 Integrator altitude

```
your app ──POST /v1/token/mint|add|transact──► units-api
   1. envelope + dev token + JWT (+ signature for transact) checks, scopes, OPA authz
   2. resolve class → config → programId; check the op is in the program's advertised operations
        (no config / unknown program → 400 primitive_capability_missing; op not listed → 400 operation_not_supported)
   3. transfer → federation transfer saga; everything else → "domain lifecycle" plan
   4. returns {txId, status:"submitted"}   ← this is all you get synchronously
          │
          ▼  Restate workflow → Kafka → token engine
   5. engine: load config & class, check standard, capability gate, load token, verify commitment,
              program.validate, pre-hooks, program.execute, persist (1 DB tx), post-hooks, audit
   6. transaction row → completed | failed {code,message} | awaiting_signature
          │
          ▼
your app ──POST /v1/transaction/status {txId}── poll until terminal
```

### 2.2 What the API forwards from `/v1/token/transact` (code-verified)

| `operation` | API route | Fields forwarded to the program |
|---|---|---|
| `transfer` | federation transfer saga (or same-instance NFT `local_transfer`) | `to`, `value`, `toAddress`, `category`, `data` (proxy proofs), `signed_lock_envelope` |
| anything else | `StartDomainLifecycle` | **only `value`, `data`, `metadata`, `extensions`** |

**Consequence:** top-level `reason`, `frozenBy`, `lockedBy`, `lockUntil`, `category` and `to` are accepted by the request schema but **not forwarded** for non-transfer operations. For **domain operations** (credential, voucher, loan, pool), put every field inside `data`. For **fungible primitives**, the server fills in `lockedBy` (your account) and `reason` (default `"federation_primitive"`), and your top-level values are ignored. The examples in this file follow that rule.

### 2.3 Two execution shapes

| Shape | Programs | What the engine receives | Your `data` becomes |
|---|---|---|---|
| **Primitive ops** (the program declares a plan for the op) | `fungible` (mint, burn, freeze, unfreeze, lock, unlock, update, transfer), `non-fungible` (mint, burn, transfer) | an op named after the primitive (`burn`, `lock`…) with `{accountDid, value, reason, …}` | mostly ignored (except `update`'s `data`/`metadata`) |
| **Domain lifecycle** (no plan → `domain_lifecycle` template) | `credential`, `loan-nft-program`, `loan-pool-nft-program`, `stables` (import/reconcile), `hello-token`, and attempted for the voucher | `operation:"domain_lifecycle"` with `payload.operation = <your op>` | **create ops** (`mint`, `loan_originated`, `add`, `import`): the program sees `{tokenClass, metadata, data:<your data>, identities, relationships, initialSupply}`. **Other ops**: the program sees **the contents of your `data`** at the top level (plus `tokenId`, `metadata`, `extensions` if absent) |

So for a loan op you send `{"operation":"payment_received","tokenId":"…","data":{"value":"4496",…}}`, and the program parses `{"value":"4496",…}` as `PaymentReceivedPayload`.

### 2.4 Engine pipeline (engineer detail, exact order)

1. **Idempotency read** (federation ops): `(txn_id, op_seq)` in `primitive_ops`. If it's already executed, the cached completion is replayed and nothing runs again.
2. `transactions` row → `processing`.
3. Load `token_class_configs WHERE token_class=$1 AND status='active'` → else `CONFIG_NOT_FOUND`.
4. `is_fungible` = class `metadata.fungible` (**default true** if absent).
5. `registry.get_program(programId)` → else `PROGRAM_NOT_FOUND`.
6. **Standard whitelist**: the class `token_standard` must be in `program.supported_standards()` (exact, case-sensitive `Vec::contains`) → else `UNSUPPORTED_TOKEN_STANDARD`.
7. Request-envelope shape check for federation primitives (`requestEnvelope` base64 with matching `method`, `txn_id` and `op_seq`).
8. **Capability gate** on the outer verb. It requires a federation context (`opSeq>0` + `callerInstance`), and the normalised verb must be in `primitive_capabilities().supported_primitive_methods` → else `CAPABILITY_DENIED`. So `domain_lifecycle` needs `DomainLifecycle`, and `burn` needs `Burn`.
9. **`domain_lifecycle` unwrap** → the inner verb becomes the operation type (the shape is described in §2.3).
10. Build `TokenClassData {tokenClass, tokenStandard, metadata}` + `{program_id, config}` and the `ExecutionContext`.
11. PROXY-FT transfer: resolve the recipient's wallet into `toWalletAddress`.
12. Load **`additionalStateRequirements`** tokens (each one commitment-verified).
13. Get or create the token state. Create ops are `mint`, `add` and `loan_originated` (`import` uses a chain lookup). Fungible creates reuse the owner's existing token of the class. Loan and pool programs require `tokenId` for non-create ops.
14. **Mandatory commitment verification** on the existing token → `DATA_INTEGRITY_VIOLATION`.
15. Mandatory envelope verification (`create_incoming`/`commit_credit`).
16. `program.validate_operation()`.
17. **Pre-hooks** sorted by `priority` (failure → `HOOK_FAILED` / mapped code).
18. `program.execute()` → `OperationResult {new_state, affected_states[], …}`.
19. If `custom_state.pendingTransfer` is set → status `awaiting_signature` with the unsigned transaction in `responseData`.
20. **One DB transaction**: for every affected token, write `tokens` (optimistic lock on `state_version`), `token_transactions` and `state_history`, then mark `primitive_ops` executed.
21. **Post-hooks** (errors are only logged). Apply `modified_state` / `secondaryOperations` outputs.
22. **Audit log** per affected token (`audit_events`).
23. `transactions.status` → `completed` (+ `metadata.affectedTokenIds`, identities) or `failed {code, message, system}`.

Retries: only DB, Kafka, concurrency and callback errors are retried (3 attempts with backoff). **Program errors are never retried**: they fail the transaction and go to the DLQ.

### 2.5 The trait (verbatim, `token-program-interface/src/traits.rs`)

```rust
pub type ProgramResult<T> = Result<T, ProgramError>;

#[async_trait]
pub trait TokenProgram: Send + Sync {
    /// Must match `program_id` in the `token_programs` table / token_class_configs.program_id.
    fn program_id(&self) -> &str;
    fn name(&self) -> &str { self.program_id() }
    fn version(&self) -> &str { "1.0.0" }
    /// Examples: `["UNITS-FT", "ERC-3643", "ERC-20"]`
    fn supported_standards(&self) -> Vec<String>;
    fn supported_operations(&self) -> Vec<String>;
    /// Default is explicit no-transfer support.
    fn primitive_capabilities(&self) -> PrimitiveCapabilities { PrimitiveCapabilities::no_transfer() }
    fn supports_operation(&self, operation: &str) -> bool { self.supported_operations().iter().any(|op| op == operation) }
    fn supports_standard(&self, standard: &str) -> bool {
        self.supported_standards().iter().any(|s| s.eq_ignore_ascii_case(standard))
    }
    async fn execute(&self, ctx: &ExecutionContext, operation: Operation, token_state: TokenState)
        -> ProgramResult<OperationResult>;
    fn validate_operation(&self, operation: &Operation, token_state: &TokenState) -> ProgramResult<()>;
    /// Workflow executors use this to drive multi-step operations (e.g. federated transfer).
    fn plan(&self, _operation: &str) -> Option<OperationPlan> { None }
    /// Hex-encoded hash string (e.g., "0xabcdef...")
    fn compute_state_commitment(&self, state: &TokenState) -> String;
}
```
Note: the engine checks standards with an exact `contains`, **not** with the case-insensitive `supports_standard`.

### 2.6 Capability presets (what each program can do across federation)

| Preset | Used by | supportedPrimitiveMethods | transferable |
|---|---|---|---|
| `fungible_balance` | fungible | Lock, CommitDebit, Unlock, CreateIncoming, CommitCredit, RejectIncoming, Credit, Debit, Mint, Burn, Freeze, Unfreeze, Update | yes (two-party prepare/commit) |
| `unique_ownership` | non-fungible | Lock, CommitDebit, Unlock, CreateIncoming, CommitCredit, RejectIncoming, Mint, Burn, DomainLifecycle | yes |
| `soulbound_credential` | credential | DomainLifecycle | no |
| `proxy_ledger` | stables | RecordProxyEntry, Credit, Debit, Reconcile, DomainLifecycle | yes (proxy proof) |
| `semi_fungible_policy_bound` | purpose-bound-voucher | Lock, CommitDebit, Unlock, CreateIncoming, CommitCredit, RejectIncoming, Credit (**no DomainLifecycle, no Mint**: this is why the voucher is blocked) | yes |
| `domain_lifecycle` | loan-nft-program, loan-pool-nft-program, hello-token | DomainLifecycle | no |

---

## 3. Shared conventions for all examples

Every write uses the envelope below. Put a fresh `msgId` on every attempt. The operator or user JWT goes in `context.authorization`, and `signature` is required on `/v1/token/transact` when the instance enforces signatures. This is environment-dependent, so always build signing in.

```json
{
  "context": {"id":"api.token.transact","version":"1.0","ts":"2026-10-03T10:00:00Z","msgId":"<uuid>",
              "developerToken":"<DEV_TOKEN>","authorization":"Bearer <JWT>","valueFormat":"raw"},
  "payload": { "operation":"<op>", "tokenId":"<uuid>", "value":"<string>", "data":{ } },
  "signature": {"keyId":"<active ed25519 key id>","jws":"<std-base64 raw Ed25519 sig over RFC8785 JCS(payload)>"}
}
```
Synchronous answer to `transact` (HTTP 202):
```json
{"context":{"…":"…","status":"accepted","transactionId":"0199…"},
 "response":{"txId":"0199…","status":"submitted","message":"Domain lifecycle workflow submitted for primitive orchestration","workflowInstanceId":"0199…"}}
```
Then poll `/v1/transaction/status {txId}`. Below, "payload" means the `payload` object only.

Amount rules:
- All amounts are **strings**.
- `valueFormat:"raw"` means base-unit integers, and `"display"` means decimals scaled by class `metadata.decimals`. The code default is display, so always set it.
- Generic operations use **`value`** (never `amount`).
- Loan and pool money fields are integer strings, and are **not** scaled by `valueFormat`.

---

## 4. Program: `fungible`

**Model:**
- Each owner has **one token per class**. `state.balance` is the authoritative holding.
- The issuer's token also carries `state.supply {totalSupply, circulatingSupply, usedSupply, availableSupply}`.
- Spendable balance = `balance − Σ locks[].value`. Pending inbound (`incoming[]`) only counts after commit.

| Operation | Purpose | Endpoint | Payload (integrator) | Effect | Typical errors |
|---|---|---|---|---|---|
| `mint` (new) | create the issuer's token with an initial supply | `/token/mint` | `{"tokenClass":"ACME-PTS","initialSupply":"500000000","metadata":{"name":"…","tags":{}},"data":{}}` | new token; `supply = {total=circ=available=S, used=0}`, `balance=S`; caller is issuer, creator and owner | `MAX_SUPPLY_EXCEEDED`; `403` not issuer; `INVALID_PAYLOAD "initialSupply is required…"` |
| `mint` (top-up) | add supply | `/token/mint` (same caller, same class) | same | the engine finds the caller's existing token: total, circulating and available `+= v`; `balance = available` | `INVALID_PAYLOAD "Mint value must be greater than zero"`, `INVALID_TOKEN_STATUS` (if frozen) |
| `burn` | destroy units | `/token/transact` | `{"operation":"burn","tokenId":"…","value":"1000"}` | `balance -= v`. Issuer burn also reduces supply. Balance 0 → status `burned`. Without `value` it burns the **whole balance** | `INSUFFICIENT_BALANCE`, `TOKEN_LOCKED` (any lock blocks burn), `MIN_BALANCE_VIOLATED`, `UNAUTHORIZED` (validation hook: not owner) |
| `freeze` | compliance hold; blocks spending | `/token/transact` | `{"operation":"freeze","tokenId":"…"}` | status `frozen`; `customState {frozenAt, frozenBy, freezeReason}` (overwrites custom state) | `INVALID_TOKEN_STATUS` (already frozen or burned) |
| `unfreeze` | lift the hold | `/token/transact` | `{"operation":"unfreeze","tokenId":"…"}` | status `active`; adds `unfrozenAt/By` | `INVALID_TOKEN_STATUS` (not frozen) |
| `lock` | reserve an amount (escrow) | `/token/transact` | `{"operation":"lock","tokenId":"…","value":"2500"}` | pushes `locks[] {value, txnId:<this txId>, opSeq, lockedBy:<you>, lockedUntil:+timeout}`. Balance unchanged; available reduced | `INSUFFICIENT_BALANCE`, `MIN_BALANCE_VIOLATED` |
| `unlock` | release a lock | `/token/transact` | `{"operation":"unlock","tokenId":"…"}` | releases the lock keyed by `(txnId, opSeq)`. **The server fills `txnId` with the *unlock's own* txId**, so releasing an earlier standalone lock through the API is **unverified**. Test before relying on API-level lock/unlock for escrow | `VALIDATION_FAILED "no lock for (txn_id…)"` |
| `update` | change display metadata or merge data | `/token/transact` (needs **manage** permission) | `{"operation":"update","tokenId":"…","metadata":{"name":"Treasury","description":"…","tags":{"tier":"gold"},"externalUrls":["https://…"]},"data":{"programme":"2027"}}` | metadata: only `name`, `description`, `tags` (replaced) and `externalUrls`. `data` is shallow-merged | `INVALID_PAYLOAD` |
| `transfer` | move value to another account | `/token/transact` | `{"operation":"transfer","tokenId":"<your token>","to":"bob-address","value":"2550"}` | saga: `lock`(source) → `create_incoming`(dest) → `commit_debit`(source) → `commit_credit`(dest). Compensation: `reject_incoming` + `unlock`. The recipient's token is created on first receipt | sync `400 "recipient address is required for transfer"`, `404 recipient_address_not_found` (**every recipient on sanctum, Aug 2026**: suspected missing recipient key registration); async `INSUFFICIENT_BALANCE`, `MIN_BALANCE_VIOLATED` |

Notes:
- `to` is the recipient's **plaintext address** (username), not a hash or DID. With `valueFormat:"display"` you would send `"value":"25.50"`.
- **User burns** don't credit the issuer's reserve unless the config adds `{"key":"issuer","tokenClass":"SELF",…}` to `additionalStateRequirements` (see `token-classes.md` §3.4).
- A non-numeric `value` in burn parses as 0, which is a **silent no-op**. Validate amounts client-side.
- Hooks that matter: `max-supply` (mint), `min-balance` (transfer, burn, lock, debit) and `validation` (owner check on transfer and burn).
- **`min-balance` needs a `value`.** When `metadata.minBalance` is set and the hook applies to the op, an op without `value` (whole-balance burn, whole-token lock) fails with `INVALID_PAYLOAD "Could not determine operation value for minBalance check"` (`hooks/min_balance.rs`). The hook's `operations` filter is honoured by the engine (`hook_runner.rs`). So either always send `value` on burn and lock, or leave `lock` out of the hook's `operations` and accept that the transfer-time lock is then unchecked (a transfer's source step runs as `lock`). Recommended: keep `lock` in the list and always send `value`.
- **`maxSupply` is per issuer token, not class-wide.** The hook compares `metadata.maxSupply` with `state.supply.totalSupply` of the token being minted into (`hooks/max_supply.rs`), and a mint lands in the minting account's own token. With one issuer (the default: registering stamps you as the only issuer) that is effectively the class cap. If the class lists several issuers, or is open (`identities: []`), each minter gets its own token and its own cap. Issuer burns reduce `totalSupply`, which frees headroom; user burns don't.
- **How per-user balances come about.** A fungible mint goes into the minting account's token (engine `get_or_create_token_state`: owner + class lookup), so an operator can't mint "into" a customer, and repeated operator mints only top up the operator's one token. A customer's own holder token (balance only, no `supply`) is created by the **credit side of a transfer** (`create_incoming`/`commit_credit` on the recipient). `credit`/`debit` are reversal primitives, not an operator payout API. So per-user balances on UNITS need a working `transfer`, which was failing on sanctum (Aug 2026). Until it works on your instance, keep per-user balances off-ledger (see `worked-examples.md` D7).
- Internal operations you never call directly: `commit_debit`, `create_incoming`, `commit_credit`, `reject_incoming`, and `credit`/`debit` (reversals keyed by `reversesTxn`).

Full transfer envelope (display format, signed):
```json
{"context":{"id":"api.token.transact","version":"1.0","ts":"…","msgId":"…","developerToken":"<DEV_TOKEN>","authorization":"Bearer <ALICE_JWT>","valueFormat":"display"},
 "payload":{"operation":"transfer","tokenId":"0199a1b2-…","to":"bob","value":"25.50"},
 "signature":{"keyId":"<alice key id>","jws":"<sig>"}}
```
→ `202 {"txId":"…","status":"submitted","message":"Transfer workflow submitted for primitive orchestration"}`. Federation lifecycle detail: `POST /v1/transactions/status {"txn_id":"…"}` (SA-only) → `SUBMITTED|PREPARED|COMMITTING|COMMITTED|ABORTED|…`.

---

## 5. Program: `non-fungible`

> In code; **not exercised live**. Configure the `validation` pre-hook, because the program has no owner check of its own.

| Operation | Endpoint | Payload | Effect | Errors |
|---|---|---|---|---|
| `mint` | `/token/mint` | `{"tokenClass":"ACME-DEED","initialSupply":"1","metadata":{"name":"Plot 42"},"data":{…}}` | a **new token every time**: status `active`, balance `"1"`; caller is creator and owner (issuer if the class says so). An empty name becomes `"<CLASS> #<8 chars>"` | `VALIDATION_FAILED "NFT already exists…"` (re-mint into an existing id) |
| `burn` | `/token/transact` | `{"operation":"burn","tokenId":"…"}` | status `burned`, `effectiveUntil=now` | `INVALID_TOKEN_STATUS`, `TOKEN_NOT_FOUND`, `UNAUTHORIZED` (validation hook) |
| `transfer` | `/token/transact` | `{"operation":"transfer","tokenId":"…","to":"bob","value":"1"}` | **same instance**: a single `local_transfer` flips the owner (message "Same-instance NFT ownership transfer submitted…"). **Cross-instance**: lock → create_incoming (dest placeholder `pending`) → commit_debit (source `transferred_out`) → commit_credit (dest `active`) | sync `400 "NFT federation transfer amount must be 1"`; async `INVALID_TOKEN_STATUS` |
| `lock` / `unlock` | (internal transfer steps) | — | lock requires value `"1"` | not recommended as API calls |

State machine: `(new) –mint→ active –burn→ burned`. Source: `active –lock→ active(balance 0) –commit_debit→ transferred_out`. Destination: `pending –commit_credit→ active` or `–reject_incoming→ rejected`.

---

## 6. Program: `credential` (soulbound W3C VC)

The supported operations are **only** `add`, `revoke`, `suspend` and `resume`. There is no transfer or burn (`operation_not_supported`, and the API transfer gate refuses `credential_program_is_soulbound_no_transfer`).

### 6.1 `add` (issue): `POST /v1/token/add`, developer token only

```json
{"context":{"id":"api.token.add","version":"1.0","ts":"…","msgId":"…","developerToken":"<DEV_TOKEN>"},
 "payload":{
   "tokenClass":"ACME-KYC",
   "owner":"<sha256(lower(trim(holder address)))>",
   "credential":{
     "@context":["https://www.w3.org/ns/credentials/v2"],
     "type":["VerifiableCredential","KYCCredential"],
     "issuer":{"id":"did:web:acme.example","name":"ACME Fintech"},
     "validFrom":"2026-10-03T11:00:00Z",
     "validUntil":"2027-10-03T11:00:00Z",
     "credentialSubject":{"id":"<same hash>","documentType":"pan","country":"IN",
                          "faceMatchVerified":true,"faceMatchPercentage":"96.0",
                          "givenName":"Asha","familyName":"Rao","documentNumber":"XXXXX1234X"},
     "evidence":[{"type":["KYCEvidence"],"rawPayload":{"provider":"acme","checkId":"K-1"}}]},
   "metadata":{"name":"ACME KYC — Asha","tokenStandard":"UNITS-CREDENTIAL"}}}
```
Field rules:

| Field | Type | Rule |
|---|---|---|
| `tokenClass` | string | a class bound to `credential` |
| `owner` | string | **address hash** of an existing account. Omit it when a user JWT is present (the owner is then the session account; a mismatch gives 403) |
| `credential.@context`, `type` | string[] | W3C VC |
| `credential.issuer` | string or `{id,name}` | — |
| `credential.validFrom` / `validUntil` | RFC3339 | become `state.effectiveFrom` / `effectiveUntil` (no automatic expiry) |
| `credential.credentialSubject` | object, **closed** | required: `id`, `documentType`, `country`, `faceMatchVerified` (bool), `faceMatchPercentage` (string). Optional: `givenName`, `familyName`, `documentNumber`, `documentExpired`, `dateOfBirth`, `address`, `gender` |
| `credential.evidence[]` | `{type[], rawPayload{any}}` | where any domain data goes; image URLs are downloaded to storage |
| `metadata` | `{name, tokenStandard}` | **required** |

Effect:
- A new token with `data` = the VC and status `active`.
- Identities: the holder's (`owner` = the holder's address hash). The integrator gets no identity, so revoke, suspend and resume need the holder's session or a `transact` delegation.
- An empty name is generated from the subject.

Response: `{"txId","status":"submitted","message":"credential_add_transaction_submitted"}`. **Poll with the holder's JWT.**

### 6.2 `revoke`, `suspend`, `resume`: `/v1/token/transact`

```json
{"operation":"revoke","tokenId":"<cred id>","data":{"reason":"Document expired","revokedBy":"acme-ops"}}
{"operation":"suspend","tokenId":"<cred id>","data":{"reason":"Under review","suspendedBy":"acme-ops","suspendUntil":"2026-12-01T00:00:00Z"}}
{"operation":"resume","tokenId":"<cred id>","data":{"reason":"Review cleared","resumedBy":"acme-ops"}}
```
| Op | Allowed from | Result | Error otherwise |
|---|---|---|---|
| `revoke` | active, frozen | status `burned` (terminal); `customState {revokedAt, revokedBy, reason}` | `TOKEN_NOT_FOUND`, `INVALID_TOKEN_STATUS "burned (already revoked)"` |
| `suspend` | active | status `frozen`; `customState {suspendedAt, suspendedBy, reason, suspendUntil}` (`suspendUntil` is informational only; there is no auto-resume) | `INVALID_TOKEN_STATUS` |
| `resume` | frozen | status `active`; `customState {resumedAt, resumedBy, reason, previousSuspension}` | `INVALID_TOKEN_STATUS "resume (credential is not suspended)"` |

State machine: `(new) –add→ active ⇄(suspend/resume) frozen`, and `active|frozen –revoke→ burned`.

A verifier checks `state.status == "active"` and `effectiveUntil` themselves. There's no status-list endpoint.

### 6.3 Credential provenance and what a verifier should check

- **Lifecycle control.** The integrator gets no identity on the credential, so revoke, suspend and resume need the holder's session or a `transact` delegation from them. Plan your revocation flow around that.
- `credential.issuer` is caller-supplied text, and UNITS doesn't verify VC proofs.
- **Verifier trust check (recommended):** verifiers should validate credential provenance (expected token class, VC `issuer`, provider signature/evidence, and confirmation from the issuing provider) rather than relying on class membership alone.
  1. `tokenClass` is the provider's class and `tokenClassInfo.tokenStandard` is `UNITS-CREDENTIAL`.
  2. `state.status == "active"` and now is within `effectiveFrom`/`effectiveUntil`.
  3. The holder is who you think: an `owner` identity equals `sha256(lower(trim(<holder address>)))`.
  4. **Provenance from the provider.** Either (a) the provider puts a detached signature in `evidence[].rawPayload` (for example Ed25519 over the JCS of `{tokenClass, owner, credentialSubject, validFrom, validUntil}`), and you verify it against a key the provider publishes (for example its `did:web` document); or (b) the provider confirms the `tokenId`/`txId` to you over an authenticated channel, or from a register of issued ids it keeps.
  5. Optionally ask the provider to grant the holder a delegation-based view to you rather than trusting a tokenId the holder hands over.
- **Least privilege for issuers:** request `tokens:create` only for clients that need it, and narrow your own client with `allowedOperations` such as `{"tokens:create":{"payload.tokenClass":["ACME-KYC"]}}`.

---

## 7. Program: `stables` (PROXY-FT shadow balances)

The program mirrors an on-chain ERC-20 or SPL balance. The balance lives in `state.supply.totalSupply` (= `circulatingSupply`) and `data = {chainId, walletAddress, contractAddress, decimals}`. On-chain reads, builds and submits go through the instance's **chain adapter** (environment-dependent).

| Operation | How you trigger it | Payload | Effect | Errors |
|---|---|---|---|---|
| `import` | `/v1/token/add` (proxy shape) | `{"tokenClass":"USDC","chainId":"eip155:84532","contractAddress":"0x036CbD53842c5426634e7929541eC2318f3dCF7e","walletAddress":"0xAlice…","value":"25000000"}` (+ `"owner":"<hash>"` when sessionless) | the adapter reads the on-chain balance. If `onChain ≥ value`, creates the token with shadow balance = `value` | sync: `400 "contractAddress does not match registered contract…"`, `403 "Wallet address not registered"`, `409` duplicate (sessionless). Async: `INSUFFICIENT_BALANCE`, `VALIDATION_FAILED` (bad address format), `INTERNAL_ERROR` (adapter) |
| `reconcile` | `/v1/token/add` with the same (owner, chain, contract, wallet) **and a user session** | same as import | shadow balance := current on-chain balance (up or down) | adapter errors |
| `transfer` | `/v1/token/transact` **after** you have executed the on-chain transfer yourself | `{"operation":"transfer","tokenId":"…","to":"bob","value":"5000000","toAddress":"0xBob…","data":{"chainId":"eip155:8453","txHash":"0xabc…","proxyProof":{"status":"confirmed","blockNumber":123}}}` | saga with proxy primitives (`record_proxy_entry` / `debit` on the sender's shadow, `credit` on the recipient's shadow, created if absent). The shadow must cover `value` | sync: `400 proxy_proof_must_be_confirmed`; `toAddress` must be a registered key of the recipient. Async: `VALIDATION_FAILED "proxy proof must be confirmed"`, `INSUFFICIENT_BALANCE`, replay conflict |
| `sign` | legacy two-phase flow | `{"operation":"sign","tokenId":"…","data":{"signedTx":"0x<64-hex tx hash or raw signed tx>","value":"250000"}}` | submits (or accepts the hash of) a signed transaction, polls the chain (up to ~30 × 1 s), then debits the shadow | `INTERNAL_ERROR "Transaction … not confirmed after N attempts"` |

`proxyProof` is confirmed when `confirmed:true` **or** `status` ∈ `confirmed|success|succeeded|finalized|finalised`.

**`awaiting_signature` flow (legacy, environment-dependent).** In the program's own `transfer` operation:
1. It checks that the on-chain balance equals the shadow ("Run reconcile first" otherwise).
2. It builds an unsigned transaction and stores it in `customState.pendingTransfer`.
3. The engine marks the transaction **`awaiting_signature`**. `POST /v1/transaction/get` → `responseData {unsignedTx, chainId, from, to, contractAddress, value, tokenId}`.
4. The user signs (and usually broadcasts) it and submits `sign` with the transaction hash. The shadow is debited when the chain confirms.

Current units-api routes `transfer` on PROXY-FT to the proof-based saga in the table above, so you will normally use that path. Handle `awaiting_signature` in your poller anyway: treat it as "needs the user's wallet", not as an error.

---

## 8. Program: `purpose-bound-voucher` (UNITS-SFT): **blocked**

> **Status (live Aug 2026 + current code):** the capability preset lacks `DomainLifecycle` and `Mint`, so `mint`, `issue`, `redeem` and `revoke` submitted through the API fail at poll time with
> `CAPABILITY_DENIED: program 'purpose-bound-voucher' does not support federation primitive 'domain_lifecycle' (supported: ["Lock","CommitDebit","Unlock","CreateIncoming","CommitCredit","RejectIncoming","Credit"])`.
> Vouchers can't be created on current builds. What follows documents the program so you can design against it and re-test after a fix. The workaround is a `UNITS-FT` class with category rules in your app (`token-classes.md` §6.7).

### 8.1 Types

```rust
#[serde(rename_all = "camelCase")]
pub struct VoucherData {                 // token.data
    pub value: String,                   // u128 string, smallest unit (class decimals)
    pub category_limits: HashMap<String, String>, // "categoryLimits": per-category caps; Σ ≤ value
    pub status: VoucherStatus,           // "Created" | "Active" | "Redeemed" | "Revoked" | "TransferredOut"
    pub expiry_date: String,             // "expiryDate": "YYYY-MM-DD", must be in the future at mint
}
pub struct VoucherIssuePayload  { pub to: String }
pub struct VoucherRedeemPayload { pub redemptions: HashMap<String, String>, pub order_reference: Option<String>, pub to: Option<String> }
pub struct VoucherRevokePayload { pub reason: String }   // required
```
Categories that aren't listed in `categoryLimits` share the **unallocated pool** (`value − Σ limits`).

### 8.2 Operations (intended payloads)

| Op | Payload | Rules | Effect |
|---|---|---|---|
| `mint` (`/token/mint`) | `{"tokenClass":"ACME-MEAL","initialSupply":"300000","metadata":{"name":"…","tokenStandard":"UNITS-SFT"},"data":{"value":"300000","categoryLimits":{"meals":"200000","groceries":"100000"},"status":"Created","expiryDate":"2027-03-31"}}` | `value > 0`; `status` must be `"Created"`; expiry in the future; each limit is a u128 string; `Σ limits ≤ value`; limit keys ⊆ class `redeemableCategories` | data `Created`, state `active`; supply = value; caller is issuer, creator and owner; `effectiveUntil` = expiry 23:59:59Z |
| `issue` | `{"operation":"issue","tokenId":"…","data":{"to":"<beneficiary>"}}` | data `Created`; initiator == owner; not locked; `credential-verification` pre-hook (if configured) | data `Active`; owner := `to` (issuer and creator kept) |
| `redeem` | `{"operation":"redeem","tokenId":"…","data":{"redemptions":{"meals":"15000","groceries":"5000"},"orderReference":"ORD-123"}}` (the API scales `data.redemptions` when `valueFormat:"display"`) | data `Active`; initiator == owner; categories allowed; capped amount ≤ cap; uncapped ≤ pool; total ≤ value | value and caps decremented; value 0 → `Redeemed` (data + state) |
| `revoke` | `{"operation":"revoke","tokenId":"…","data":{"reason":"Policy violation"}}` | data `Created` or `Active`; initiator holds an **issuer** identity | value and caps → 0; data `Revoked`, state `burned` |
| `transfer` (split) | `{"operation":"transfer","tokenId":"…","to":"jane","value":"10000","category":"meals"}` | `category` required; class `metadata.transferable:true` **and** config `voucherTransfer.enabled:true` (else sync `400 voucher_transfer_policy_disabled`) | lock(cat, v) → create_incoming (**new** destination token with `{cat: v}`) → commit_debit → commit_credit |

State machine: `mint → Created –issue→ Active –redeem*→ Redeemed`. `Created|Active –revoke→ Revoked (state burned)`. A split source goes `Active →(value 0) TransferredOut`.

Known code gaps:
- The `credential-verification` hook compares `data.type` **as a string**, so standard VCs (array `type`) never match.
- `redeemer_credentials` is loaded but unused.
- The `escrow-transfer` hook referenced by `redeem.to` doesn't exist.

---

## 9. Program: `loan-nft-program` (one token per loan)

**Design: "trust the payload".**
- The program does **no financial arithmetic**. Your LOS/LMS computes the new cumulative values (`newPrincipalOutstanding`, `newDpd`, `newLoanEntityStatus`…), and the program checks preconditions, then copies them in.
- Computed internally: `maxDpd` (on dpd_change), `rescheduleCount`, `cersaiModifiedCount`, additive charge `collectedAmount`, charge ids (UUIDv7), and `remainingTenure = 0` on close.
- `state.status` stays `active` forever. The business status is `data.loanEntityStatus`.
- **No transfer or burn** (the API refuses: `loan_program_requires_domain_lifecycle_or_assignment_template`).
- **No program-level authorisation.** Whoever can transact on the token (owner or delegate) can run any operation.

### 9.1 Encoding rules (most common failure source)

| Kind | JSON | Fields | Wrong → |
|---|---|---|---|
| u128 (money, ratios, rates) | **string of digits**, no decimal point | loanAmount, value, plannedAmount, interestRate, emiPerMonth, foir, penalRate, spread, ltvRatio, all `new*Amount`/`newPrincipalOutstanding`/`newOverdueAmount`, `collectedAmount`, `writeOff*`, `finalSettlementAmount`, `newRate`, `newBenchmarkValue`, `newEmiAmount`, `newFoir`, `newLtvRatio`, `newPenalRate`, `newSpread` | `"invalid type: integer, expected a string"` / `"invalid digit found in string"` |
| u32 | **JSON number** | tenure, emiDay, prepaymentLockInMonths, tranche, emiNumber, newDpd, newEmisPaid, dpd, newEmiDay, newTenure, newRemainingTenure, newTenureMonths, dpdAtLevy | `"invalid type: string, expected u32"` |
| enum | **PascalCase string** | LoanEntityStatus `Active|Delinquent|NPA|WrittenOff|Closed`; InterestRateType `Fixed|Floating`; DisbursementStatus `NotStarted|Partial|Full`; PaymentType `FullEMI|PartialEMI|PrePayment|ForeclosurePayment|ChargePayment`; ChargeStatus `Levied|Collected|PartiallyCollected|Waived`; LockInRestriction `NoForeclosure|NoPrepayment`; ClosureType `Regular|Prepayment|WriteOffSettlement` | `unknown variant` |
| dates | string `YYYY-MM-DD` | all `*Date` | only `originationDate` is parsed (lock-in check); a bad value there gives `INTERNAL_ERROR` |
| keys | **camelCase** | all | `missing field …` |

- **`foir`**: integer string in **1..10000** in current code (the bound suggests basis points). The error text "foir must be in (0, 1]" is misleading. `"0"` fails. **Send `"1"`** (live-verified).
- Rates and ratios are opaque integers, so pick one convention (e.g. bps) and use it consistently.

> **`value` vs `amount` (environment-dependent):** current code (token-runtime refactor "amount→value") reads **`value`** in `loan_disbursed`, `payment_received`, `charge_levied` and `penal_charge_levied`. Older deployed builds expected **`amount`**. The examples below use `value`. If your instance rejects them with `INVALID_PAYLOAD … missing field 'amount'`, resend with `amount`. The payload structs ignore unknown keys, so including both keys with the same value also works on either build.

### 9.2 The 22 operations (plus the `mint` alias)

| # | Operation | Allowed prior `loanEntityStatus` | Mutates |
|---|---|---|---|
| 0 | `mint` = `loan_originated` | (new token) | creates LoanData |
| 1 | `loan_disbursed` | Active, Delinquent; and `disbursementStatus ≠ Full` | disbursements[], disbursementAmount, principalOutstanding, disbursementStatus |
| 2 | `emi_due` | Active, Delinquent, NPA | nextEmiDate |
| 3 | `payment_received` | Active, Delinquent, NPA (+ lock-in rule) | principalOutstanding, overdueAmount, lastPayment*, emisPaid, dpd, loanEntityStatus |
| 4 | `dpd_change` | Active, Delinquent, NPA | dpd, maxDpd, loanEntityStatus |
| 5 | `loan_rescheduled` | Active, Delinquent, NPA | emiDay, emiPerMonth, tenure, remainingTenure, maturityDate, nextEmiDate, penalRate, benchmark?, spread?, isRescheduled, rescheduleCount, rescheduleHistory[] |
| 6 | `emi_modified` | Active, Delinquent, NPA | emiPerMonth |
| 7 | `interest_rate_reset` | **Floating only**; Active, Delinquent, NPA | interestRate, benchmark?, spread? |
| 8 | `tenure_modified` | Active, Delinquent, NPA | tenure, remainingTenure, totalEmis, maturityDate |
| 9 | `cersai_registered` | any (requires `cersaiApplicable` and not yet registered) | cersaiDate, cersaiRegNumber |
| 10 | `cersai_modified` | any (requires registered) | cersaiRegNumber?, cersaiModifiedCount |
| 11 | `charge_levied` | anything except Closed | charges[] (+ new chargeId), overdueAmount |
| 12 | `charge_waived` | any (chargeId must exist) | charge → Waived, overdueAmount |
| 13 | `charge_collected` | any (chargeId must exist) | charge collectedAmount (+=), status, overdueAmount |
| 14 | `foir_updated` | Active, Delinquent, NPA | foir |
| 15 | `ltv_updated` | Active, Delinquent, NPA | ltvRatio |
| 16 | `penal_rate_revised` | Active, Delinquent, NPA | penalRate |
| 17 | `penal_charge_levied` | **Delinquent, NPA only** | penalCharges[] (+ chargeId), overdueAmount |
| 18 | `penal_charge_waived` | any (chargeId exists) | penal charge → Waived, overdueAmount |
| 19 | `penal_charge_collected` | any (chargeId exists) | collectedAmount (+=), status, overdueAmount |
| 20 | `loan_written_off` | NPA, Delinquent | writeOffData, loanEntityStatus=WrittenOff |
| 21 | `loan_closed` | Regular/Prepayment: Active, Delinquent; WriteOffSettlement: WrittenOff | closureData, remainingTenure=0, loanEntityStatus=Closed |

### 9.3 State machine (`data.loanEntityStatus`)

```
          mint / loan_originated
                   │
                   ▼
   ┌──────────► Active ◄─────────┐   payment_received / dpd_change copy newLoanEntityStatus
   │             │  ▲            │   verbatim (trust-payload): any value is accepted,
   │             ▼  │            │   including WrittenOff/Closed (nothing guards this)
   │        Delinquent ◄──► NPA  │
   │             │          │
   │             └────┬─────┘
   │                  ▼ loan_written_off (from NPA | Delinquent)
   │             WrittenOff
   │                  │ loan_closed {closureType: WriteOffSettlement}
   ▼                  ▼
 loan_closed {Regular|Prepayment} from Active|Delinquent ──► Closed (terminal; token kept as record)
```
An NPA loan can't close directly. Write it off first, or move it back to Delinquent/Active with `dpd_change`. Charge waive/collect, penal waive/collect and CERSAI operations have **no status gate** and can still change a Closed loan.

### 9.4 `mint` / `loan_originated`: full `LoanOriginatedPayload` (inside `data` of `/v1/token/mint`)

| Field | Type | Req | Notes |
|---|---|---|---|
| `loanRefId` | string | ✔ | your loan id; dedupe on it (mint isn't idempotent). The default name is `"Loan <loanRefId>"` |
| `loanAmount` | u128 str | ✔ | > 0 |
| `currency` | string | ✔ | e.g. `INR` |
| `loanType` | string | ✔ | free text (`HomeLoan`, `LivestockBackedLoan`) |
| `program` | string | ✔ | your product programme |
| `sourcingState` | string | ✔ | e.g. `KA` |
| `originationDate` | `YYYY-MM-DD` | ✔ | parsed for the lock-in rule |
| `sanctionDate` | date | ✔ | |
| `firstEmiDate` | date | ✔ | initial `nextEmiDate` |
| `interestRateType` | `Fixed`/`Floating` | ✔ | `interest_rate_reset` only for Floating |
| `collateralType` | string | ✔ | |
| `borrowerId` | string | ✔ | any reference: address hash, DID or CIF id |
| `coBorrowerIds` | string[] | – | default `[]` |
| `guarantorIds` | string[] | – | default `[]` |
| `productCode` | string | ✔ | |
| `disbursementSchedule` | `[{tranche:u32, plannedDate, plannedAmount:u128str}]` | ✔ | non-empty |
| `prepaymentLockInMonths` | u32 | ✔ | 0 = none |
| `lockInRestriction` | `NoForeclosure`/`NoPrepayment` | – | used with lock-in months |
| `cersaiApplicable` | bool | ✔ | must be true for the cersai_* operations |
| `interestRate` | u128 str | ✔ | your unit convention |
| `tenure` | u32 | ✔ | > 0. Also initialises remainingTenure and totalEmis |
| `emiDay` | u32 | ✔ | 1..31 |
| `emiPerMonth` | u128 str | ✔ | > 0 |
| `maturityDate` | date | ✔ | |
| `foir` | u128 str | ✔ | 1..10000 |
| `penalRate` | u128 str | ✔ | 0 allowed |
| `benchmark` | string | – | e.g. `REPO` |
| `spread` | u128 str | – | |
| `ltvRatio` | u128 str | – | |

Initial values set by the program: `loanEntityStatus:"Active"`, `disbursementAmount:"0"`, `disbursementStatus:"NotStarted"`, `disbursements:[]`, `principalOutstanding:"0"`, `emisPaid:0`, `dpd:0`, `maxDpd:0`, `overdueAmount:"0"`, `nextEmiDate=firstEmiDate`, `charges:[]`, `penalCharges:[]`, `rescheduleCount:0`, `cersaiModifiedCount:0`.

```json
POST /v1/token/mint
{"context":{"id":"api.token.mint","version":"1.0","ts":"…","msgId":"…","developerToken":"<DEV_TOKEN>","authorization":"Bearer <OPERATOR_JWT>","valueFormat":"raw"},
 "payload":{"tokenClass":"ACME-LOAN","initialSupply":"1","metadata":{"name":"LN20260001"},
  "data":{
   "loanRefId":"LN20260001","loanAmount":"500000","currency":"INR","loanType":"HomeLoan","program":"PMAY",
   "sourcingState":"MH","originationDate":"2026-03-07","sanctionDate":"2026-03-01","firstEmiDate":"2026-04-01",
   "interestRateType":"Floating","collateralType":"Immovable","borrowerId":"<borrower ref>",
   "coBorrowerIds":[],"guarantorIds":[],"productCode":"HL-001",
   "disbursementSchedule":[{"tranche":1,"plannedDate":"2026-03-10","plannedAmount":"500000"}],
   "prepaymentLockInMonths":12,"lockInRestriction":"NoForeclosure","cersaiApplicable":true,
   "interestRate":"900","tenure":240,"emiDay":1,"emiPerMonth":"4496","maturityDate":"2046-03-01",
   "foir":"1","penalRate":"200","benchmark":"REPO","spread":"250","ltvRatio":"7500"}}}
```
Don't send `identities`. The program makes the caller issuer, creator and owner.

#### 9.4.1 Modelling notes: extra fields, collateral, bullet loans, CERSAI (code-verified, token-runtime 86227c4)

- **Unknown keys in `data` are dropped, silently.** `LoanOriginatedPayload` and `LoanData` have no `deny_unknown_fields` and no catch-all map, and the program stores `data` by re-serialising `LoanData` (`loan_originated.rs`, and again on every later op). Extra keys such as `goldWeightGrams` or `packetId` don't fail the mint, but they are **not stored**. The `additionalProperties:false` in the seeded LOAN-NFT class schema is documentation only, as no class schema is enforced.
- **Where collateral details can go:**
  1. `collateralType`: free text, fixed at mint (e.g. `"GoldJewellery"`).
  2. `ltvRatio` at mint, then `ltv_updated` on revaluation or a gold-price move.
  3. `metadata.tags` (string→string) and `metadata.description` on the mint. These are stored as given, but **fixed after mint**, because `loan-nft-program` has no `update` op. Keep them to non-PII references, e.g. `{"packetId":"PKT-000123","vault":"BLR-04","appraisalRef":"APR-88"}`.
  4. A separate collateral token you can maintain: a `credential` (appraisal certificate: weight, purity and appraiser in `evidence[].rawPayload`; revoke and re-issue on re-appraisal) or a `non-fungible` token minted by your operator (immutable `data`). Link them through your own ids, for example `loanRefId` in the collateral token and the collateral tokenId in `metadata.tags`.
  5. Everything else, and the authoritative record, stays in your LMS. Generic asset/lien operations (`lien_marked`/`lien_released`) don't exist yet; ask Finternet for an asset program if you need them on-ledger.
- **Bullet and interest-only loans (typical gold loans).** There's no repayment-type field, and the program does no schedule arithmetic: it copies the `new*` values you send. Constraints: `tenure > 0`, `emiPerMonth > 0`, `emiDay` 1..31, and `totalEmis` is set to `tenure`. A workable mapping:
  - `tenure`: months to maturity (e.g. `12`). `maturityDate`: the bullet due date.
  - **Interest-servicing bullet** (monthly interest, principal at maturity): `emiPerMonth` = the monthly interest amount; `firstEmiDate` = first interest date. Record each interest payment with `payment_received` (`paymentType:"FullEMI"`, `towards.interest`) and send `newPrincipalOutstanding` unchanged.
  - **Pure bullet** (everything at maturity): `emiPerMonth` must still be > 0, so put the expected maturity payout there and set `firstEmiDate` = `maturityDate`. Skip monthly `emi_due`, or send one at maturity. Interim part-payments go in as `paymentType:"PartialEMI"` or `"PrePayment"`.
  - At maturity, record the final payment (`"ForeclosurePayment"` for early closure, otherwise `"FullEMI"`) with `newPrincipalOutstanding:"0"`, then call `loan_closed` (`Regular` or `Prepayment`). Renewal or top-up: close the old loan and originate a new one with its own `loanRefId`. Don't reuse the old token.
  - Put the product in `loanType`/`productCode` (e.g. `"GoldLoan"`, `"GL-BULLET-12"`) so readers can interpret `emiPerMonth`. Set `prepaymentLockInMonths: 0` unless your product really restricts prepayment, because the lock-in rule rejects `PrePayment`/`ForeclosurePayment` inside the window.
- **`cersaiApplicable`** is fixed at mint and gates the `cersai_*` ops: `cersai_registered` fails unless it's `true`, can run only once (a second call fails because `cersaiDate` is already set; amendments use `cersai_modified`), and needs a non-blank `regNumber`. Whether a given gold loan needs a CERSAI filing is a regulatory call for your compliance team; UNITS only records it. If you might file, mint with `true`: an unregistered `true` costs nothing, while `false` can't be changed later.

### 9.5 Domain operations: exact `payload` for `/v1/token/transact`

Every operation below has the shape `{"operation":"<op>","tokenId":"<loan id>","data":{…}}`. All fields shown are **required** unless marked optional.

```json
// 1 loan_disbursed — value = this tranche; new* = your computed cumulative values
{"operation":"loan_disbursed","tokenId":"…","data":{"tranche":1,"value":"500000","date":"2026-03-10","txId":"NEFT-TXN-001",
  "newDisbursementAmount":"500000","newPrincipalOutstanding":"500000","newDisbursementStatus":"Full"}}

// 2 emi_due — only nextEmiDate is stored; others logged
{"operation":"emi_due","tokenId":"…","data":{"emiDate":"2026-04-01","emiNumber":1,"expectedAmount":"4496","nextEmiDate":"2026-05-01"}}

// 3 payment_received — value > 0; towards is parsed but not stored; maxDpd NOT updated
{"operation":"payment_received","tokenId":"…","data":{"value":"4496","paymentDate":"2026-04-01","paymentType":"FullEMI",
  "towards":{"principal":"1246","interest":"3000","charges":"250"},
  "newPrincipalOutstanding":"498754","newOverdueAmount":"0","newDpd":0,"newEmisPaid":1,"newLoanEntityStatus":"Active"}}

// 4 dpd_change — maxDpd = max(maxDpd, dpd)
{"operation":"dpd_change","tokenId":"…","data":{"dpd":91,"reason":"missed_emi_3_consecutive","effectiveDate":"2026-07-01","newLoanEntityStatus":"NPA"}}

// 5 loan_rescheduled — newBenchmark/newSpread/reason/txId optional; totalEmis NOT updated
{"operation":"loan_rescheduled","tokenId":"…","data":{"newEmiDay":5,"newEmiAmount":"4800","newTenure":245,"newRemainingTenure":238,
  "newMaturityDate":"2046-08-05","newNextEmiDate":"2026-08-05","newPenalRate":"200",
  "newBenchmark":"REPO","newSpread":"275","reason":"npa_restructure","txId":"RSC-001"}}

// 6 emi_modified — newEmiAmount > 0
{"operation":"emi_modified","tokenId":"…","data":{"newEmiAmount":"4900","reason":"rate_adjustment","effectiveFrom":"2026-09-05"}}

// 7 interest_rate_reset — Floating loans only; newBenchmark/newSpread optional; newBenchmarkValue required but not stored
{"operation":"interest_rate_reset","tokenId":"…","data":{"newRate":"925","newBenchmark":"REPO","newSpread":"275",
  "newBenchmarkValue":"650","effectiveDate":"2026-08-01","resetReason":"RBI_REPO_RATE_CHANGE"}}

// 8 tenure_modified — newTenureMonths > 0; sets totalEmis too
{"operation":"tenure_modified","tokenId":"…","data":{"newTenureMonths":250,"newRemainingTenure":243,"newMaturityDate":"2047-01-05","reason":"tenure_extension"}}

// 9 cersai_registered — the lien record; once only; regNumber non-empty
{"operation":"cersai_registered","tokenId":"…","data":{"regNumber":"CERSAI-2026-MH-00001","cersaiDate":"2026-03-15"}}

// 10 cersai_modified — newRegNumber optional
{"operation":"cersai_modified","tokenId":"…","data":{"newRegNumber":"CERSAI-2026-MH-00001-A","amendmentDate":"2026-04-10","reason":"property_address_correction"}}

// 11 charge_levied — chargeId generated; read it back from token data.charges[-1].chargeId
{"operation":"charge_levied","tokenId":"…","data":{"chargeType":"ProcessingFee","value":"1000","leviedDate":"2026-05-01","newOverdueAmount":"1000"}}

// 12 charge_waived
{"operation":"charge_waived","tokenId":"…","data":{"chargeId":"<from data.charges>","waiverDate":"2026-05-15","waiverReason":"goodwill_waiver","newOverdueAmount":"0"}}

// 13 charge_collected — collectedAmount is ADDED to previous; newStatus Collected|PartiallyCollected
{"operation":"charge_collected","tokenId":"…","data":{"chargeId":"<id>","collectedAmount":"500","collectionDate":"2026-06-10","newStatus":"Collected","newOverdueAmount":"0"}}

// 14 foir_updated — 1..10000
{"operation":"foir_updated","tokenId":"…","data":{"newFoir":"1","reason":"income_reassessment","effectiveDate":"2026-06-01"}}

// 15 ltv_updated — > 0, no upper bound
{"operation":"ltv_updated","tokenId":"…","data":{"newLtvRatio":"7200","reason":"property_revaluation","effectiveDate":"2026-06-01"}}

// 16 penal_rate_revised — 0 allowed
{"operation":"penal_rate_revised","tokenId":"…","data":{"newPenalRate":"300","reason":"rbi_guideline_update","effectiveDate":"2026-07-01"}}

// 17 penal_charge_levied — Delinquent/NPA only; dpdAtLevy > 0; chargeId from data.penalCharges[-1]
{"operation":"penal_charge_levied","tokenId":"…","data":{"dpdAtLevy":91,"value":"750","leviedDate":"2026-07-15","newOverdueAmount":"750"}}

// 18 penal_charge_waived
{"operation":"penal_charge_waived","tokenId":"…","data":{"chargeId":"<id>","waiverDate":"2026-07-20","waiverReason":"goodwill","newOverdueAmount":"0"}}

// 19 penal_charge_collected
{"operation":"penal_charge_collected","tokenId":"…","data":{"chargeId":"<id>","collectedAmount":"850","collectionDate":"2026-08-10","newStatus":"Collected","newOverdueAmount":"0"}}

// 20 loan_written_off — from NPA/Delinquent; payment_received is then rejected
{"operation":"loan_written_off","tokenId":"…","data":{"writeOffDate":"2026-09-01","writeOffPrincipal":"498754","writeOffTotal":"499604","reason":"unrecoverable"}}

// 21 loan_closed — closureReason optional (not stored)
{"operation":"loan_closed","tokenId":"…","data":{"closureData":{"date":"2026-09-15","closureType":"WriteOffSettlement","finalSettlementAmount":"250000"},"closureReason":"settled_at_50pct"}}
```

**Lock-in rule (payment_received).** It applies while `today < originationDate + prepaymentLockInMonths` and `lockInRestriction` is set:
- `NoForeclosure` rejects `ForeclosurePayment`.
- `NoPrepayment` rejects `PrePayment` and `ForeclosurePayment`.
- The error is `VALIDATION_FAILED "Foreclosure is not permitted during the lock-in period…"`.

Errors for every loan operation:
- `INVALID_PAYLOAD "Invalid <Op>Payload: <serde msg>"` for type and field problems.
- `VALIDATION_FAILED "<op> requires loan_entity_status in [..], got X"` for the status gate.
- `VALIDATION_FAILED "'<op>' requires state_version > 0"` when the tokenId is wrong.
- `TOKEN_NOT_FOUND "<class>:<op> requires token_id"`.
- `UNSUPPORTED_OPERATION` for an unknown op (the API usually catches it first with `operation_not_supported`).

---

## 10. Program: `loan-pool-nft-program` (securitisation pool)

> In code; not exercised live. **Keys are snake_case** (no camelCase renaming), except `FLDG`. Money values are strings.

| # | Operation | `data` payload | Rules | Effect |
|---|---|---|---|---|
| 0 | `mint` (`/token/mint`) | full pool (below) | `total_pool_amount` is an integer string > 0; `loan_count ≥ 1` and `== len(loan_token_ids)`; `investor_share` non-empty; PTC requires `trustee_id`; the 5 status counts sum to `loan_count`; if loans were loaded, all must exist | `pool_status:"Active"`; `internal_rate_of_return:"0"`; `cumulative_principal_collected:"0"`; a `PoolLoanDependency` claim per loan on the pool; a `LoanPoolMembership` claim on each loaded loan (same DB transaction) |
| 1 | `dpd_bucket_updated` | `{"active_loan_count":1,"delinquent_loan_count":1,"npa_loan_count":0,"closed_loan_count":0,"written_off_loan_count":0,"dpd_bucket_distribution":{"current_count":1,"dpd_1_30_count":1,"dpd_31_60_count":0,"dpd_61_90_count":0,"dpd_90_plus_count":0,"dpd_1_30_amount":"500000","dpd_31_60_amount":"0","dpd_61_90_amount":"0","dpd_90_plus_amount":"0"}}` | Active; both count sums == `loan_count` | counts + distribution |
| 2 | `principal_update` | `{"principal_collected":"25000"}` | Active; u128 string (0 allowed) | `cumulative_principal_collected += v` |
| 3 | `payout` | `{"payout_amount":"22500","pool_outstanding":"925000"}` | Active; `payout_amount ≤ investor_os` | `investor_os -= payout`; `pool_outstanding := payload` (off-ledger payout record) |
| 4 | `irr_update` | `{"internal_rate_of_return":"9.25"}` | Active; free-form | stored |
| 5 | `fldg_update` | `{"new_fldg":"45000"}` | Active; non-empty | `FLDG := new_fldg` |
| 6 | `pool_rating_updated` | `{"new_rating":"AA+"}` (`null` withdraws) | not Closed | `current_rating` |
| 7 | `pool_closed` | `{"closure_date":"2026-03-14","closure_reason":"All loans settled"}` | Active (no check that `investor_os` is 0) | `pool_status:"Closed"`, `investor_os:"0"`; loans untouched |

Mint `data` (`MintPayloadData`). Required: `pool_ref_id`, `pool_type` (`PassThroughCertificate`|`DirectAssignment`), `loan_token_ids` (UUID strings), `loan_count` (u32), `originator_id`, `cutoff_date`, `total_pool_amount` (str), `min_seasoning_months` (u32), `expected_maturity_date`, `payout_day`, `investor_share` (str), `active_loan_count`, `delinquent_loan_count`, `npa_loan_count`, `closed_loan_count`, `written_off_loan_count` (u32), `pool_outstanding` (str), `investor_os` (str), `FLDG` (str). Optional: `trustee_id`, `investor_id`, `dpd_bucket_distribution` (all 9 fields), `current_rating`. A complete example is in `token-classes.md` §6.8.

Lifecycle: `mint → Active –(dpd_bucket_updated|principal_update|payout|irr_update|fldg_update|pool_rating_updated)*→ pool_closed → Closed`. A wrong status gives `VALIDATION_FAILED "<op> requires pool_status == Active, got Closed"`.

Caveats:
- Loans are loaded only if the config's `additionalStateRequirements.tokenIdsFrom` path resolves. The seed path `payload.loan_token_ids` probably doesn't after the unwrap, which means no loan-side claims and no existence check (`token-classes.md` §3.4).
- Mint `metadata` is dropped.
- The pool isn't checked to be the loans' owner, nor are the loans checked for seasoning or membership in another pool.

---

## 11. `hello-token` (onboarding exemplar)

- `programId: "hello-token"`, standard `UNITS-HELLO`, capabilities `domain_lifecycle`, operations `mint` and `update_greeting`.
- Its custom fields live in `extensions["hello-token"].greeting`. The greeting must be non-empty and at most `metadata.maxGreetingLength` (default 280).

```json
{"tokenClass":"HELLO","initialSupply":"1","extensions":{"hello-token":{"greeting":"hello federation"}}}           // /token/mint
{"operation":"update_greeting","tokenId":"…","extensions":{"hello-token":{"greeting":"updated hi"}}}                // /token/transact
```
It exists to show program authors the pattern: read input through `PrimitivePayload` and keep custom fields only under `extensions.<programId>` (the API only accepts the class's own program id as an extension namespace, `[A-Za-z0-9._-]`, ≤128 chars). It is not seeded as a class, so it's not useful to integrators.

---

## 12. Error catalogue

### 12.1 Synchronous API errors you'll meet with programs

| HTTP / code | Message | Meaning |
|---|---|---|
| 400 INVALID_INPUT | `primitive_capability_missing` | the class has no config, or its `programId` isn't advertised by this instance |
| 400 INVALID_INPUT | `operation_not_supported` | the operation isn't in the program's `supportedOperations` (check `/tokenprogram/get`) |
| 400 INVALID_INPUT | `federation transfer is not supported by this token program capability` | transfer on a credential, `UNITS-Loan` or `UNITS-LoanPool` token |
| 400 INVALID_INPUT | `NFT federation transfer amount must be 1`, `voucher_transfer_policy_disabled`, `proxy_proof_must_be_confirmed`, `recipient address is required for transfer` | transfer pre-checks |
| 400 INVALID_INPUT | `invalid_extension_namespace` / `extension_namespace_not_allowed` | `extensions` key ≠ the class's programId |
| 400 INVALID_INPUT | `token_id_required_for_domain_lifecycle_update` | a non-create operation without `tokenId` |
| 403 FORBIDDEN | `user is not authorized to mint tokens for this class` / `no_matching_allow_rule` | not the class issuer / no identity or delegation on the token |
| 404 RESOURCE_NOT_FOUND | `Token not found`, `Token class not found`, `recipient_address_not_found`, `Owner address not found` | — |
| 409 CONFLICT | `sender account is homed on another instance` | call the account's home instance |

### 12.2 Async errors in `/v1/transaction/status` → `error.code`

**Engine errors:**

| code | Meaning for an integrator | Retry? |
|---|---|---|
| `CONFIG_NOT_FOUND` | the class config is missing or not `active` | fix config |
| `PROGRAM_NOT_FOUND` | the config's programId isn't compiled into this engine | fix programId |
| `UNSUPPORTED_TOKEN_STANDARD` | the class `tokenStandard` isn't on the program's whitelist (exact case) | new class / fix the standard before minting |
| `CAPABILITY_DENIED` | the program can't run this primitive (voucher today) | no; platform fix needed |
| `INVALID_PAYLOAD` | payload unparseable, missing field, wrong type, unknown identity type, missing federation context | fix payload |
| `HOOK_FAILED` | a configured pre-hook rejected the operation (message tells why) | depends |
| `MAX_SUPPLY_EXCEEDED` | the `max-supply` hook | lower the amount / raise `maxSupply` |
| `MIN_BALANCE_VIOLATED` | the `min-balance` hook | lower the amount |
| `TOKEN_NOT_FOUND` | wrong tokenId, or a loan/pool op without tokenId | fix id |
| `DATA_INTEGRITY_VIOLATION` | the stored token (or a dependency) fails commitment verification, i.e. tampering or corruption | escalate to Finternet |
| `CONCURRENT_MODIFICATION` / `STATE_CONFLICT` | two operations on the same token raced (retried automatically) | resubmit if final |
| `DATABASE_ERROR`, `KAFKA_ERROR`, `COMPLETION_CALLBACK_ERROR` | infrastructure (retried 3×) | resubmit later; check for a duplicate first |
| `SERIALIZATION_ERROR` | unparseable message/state | report |

**Program errors (`ProgramError`, never retried):**

| code | Typical message | Raised by |
|---|---|---|
| `UNSUPPORTED_OPERATION` | "Credential program does not support 'transfer'…", "transfer executes via its operation plan…" | all |
| `INVALID_PAYLOAD` | "Invalid LoanOriginatedPayload: invalid digit found in string", "foir must be in (0, 1], got 0", "Mint value must be greater than zero", "Could not determine operation value for minBalance check" | all |
| `INVALID_TOKEN_STATUS` | "Invalid token status burned for operation revoke" | fungible, NFT, credential, voucher |
| `INSUFFICIENT_BALANCE` | required vs available | fungible, voucher, stables |
| `VALIDATION_FAILED` | "loan_disbursed rejected: disbursement_status is already Full", "payout_amount (X) exceeds investor_os (Y)", "NFT already exists…", "proxy proof must be confirmed", "On-chain balance differs from shadow balance. Run reconcile first." | all |
| `UNAUTHORIZED` | "Initiator X is not authorized to burn token…", "Only the owner … can redeem", "Only the issuer can revoke" | validation hook, voucher |
| `TOKEN_NOT_FOUND` | "Credential does not exist", "Token does not exist. Import first." | credential, stables, NFT |
| `TOKEN_LOCKED` / `TOKEN_FROZEN` | "Token is locked" | fungible, voucher, validation hook |
| `CLAIM_NOT_FOUND` / `CLAIM_ALREADY_EXISTS` | — | reserved |
| `SERIALIZATION_ERROR` | "Failed to deserialise LoanData…" | loan |
| `INTERNAL_ERROR` | adapter failures, "Cannot parse origination_date", "Transaction … not confirmed after N attempts" | stables, loan |

Hook failures are reported as `HOOK_FAILED`, except `max-supply` → `MAX_SUPPLY_EXCEEDED` and `min-balance` → `MIN_BALANCE_VIOLATED`. A "Validation failed: " prefix is stripped from the message. On failure the engine stores `{code, message, system}`; you see `code` and `message`.

---

## 13. Can I create my own token program?

**External integrators can't. There is no self-service program deployment.** Programs are Rust crates compiled into the token engine. `POST /v1/tokenprogram/register` can create a registry *row*, but it can't make any operation executable. Only engine code can, and the engine overwrites rows for programs it implements at every boot.

What to do instead:
1. **Model with existing programs first.**
   - Balances → `fungible`
   - Unique assets → `non-fungible`
   - Attestations → `credential`
   - Loans and liens → `loan-nft-program` (`cersai_registered` is the lien)
   - Pools → `loan-pool-nft-program`
   - On-chain stablecoins → `stables`

   Hooks and `additionalStateRequirements` give you supply caps, minimum balances and cross-token prerequisites without new code.
2. **If you need new operations or state** (warehouse receipt with pledge/release, invoice finance, bond coupons, generic asset with lien), **ask Finternet engineering** for a custom program. Engineering effort is "days per program". Send them:
   - the **operations** (names, snake_case) and which one creates the token
   - each operation's **payload** fields with types (strings for money, numbers for counts, enums), required/optional
   - the **state** you need on the token (`data` shape) and the **state machine** (which status allows which operation)
   - **validations and authorisation** rules (who may call what; any cross-token checks, e.g. "borrower must hold an Active KYC credential")
   - **value movement**: is it transferable or fungible? (This picks the capability preset; domain-only programs are the quickest.)
   - the **token standard** name you want (e.g. `UNITS-WR`) and the hooks/config keys you need
   - sample payloads and expected outcomes (these become the program's tests)
3. While you wait, prototype on an existing program, e.g. keep domain fields in a credential's `evidence.rawPayload` or in NFT `data` set at mint (the `non-fungible` program has no `update` operation).

**Engineers** writing a program or a hook should read `authoring-token-programs.md`. In short:
- implement the `TokenProgram` trait
- pick a capability preset (`domain_lifecycle()` for domain-only programs)
- parse input with `PrimitivePayload`, and keep custom fields under `extensions.<programId>`
- chain the commitment with `compute_state_commitment_with_config`
- register in `ProgramRegistry::register_default_programs()`, rebuild the engine, and re-publish the instance capability document

---

## 14. Quick verification calls

```json
POST /v1/tokenprogram/search   {"context":{"id":"api.tokenprogram.search",…},"payload":{"filters":{},"pagination":{"limit":50,"offset":0}}}
POST /v1/tokenprogram/get      {"context":{"id":"api.tokenprogram.get",…},"payload":{"programId":"loan-nft-program"}}
```
The response is `{id, programId, name, version, supportedStandards[], supportedOperations[], config:{primitiveCapabilities, plans, selfRegistered:true, …}, status}`. If `selfRegistered` is missing, the row is a stale seed, so don't trust its operation list.
