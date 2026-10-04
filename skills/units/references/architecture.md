# UNITS architecture

> Snapshot date **2026-10-03**. This file covers how UNITS is built and how a request moves through it.
> Deploying and operating UNITS is **out of scope** here. Before you build on any detail, check it against the live instance
> (`/v1/tokenclassconfig/get`, `/v1/tokenprogram/search`, and a test transaction polled to completion).
> When sources disagree, the order of trust is: behaviour seen live on sanctum, then current code, then
> `specs/`, then public docs.
>
> **Source snapshot.** Code-level claims were checked against source snapshots: **units-api 2026-09-17 (`29ac16f`)** and **units-token-runtime 2026-07-07 (`86227c4`)**. The runtime checkout is behind what is deployed. In these checkouts the `fungible` program's capability preset (`fungible_balance`) has no `DomainLifecycle`, while units-api routes every mint (and non-transfer transacts such as burn and freeze) through the `domain_lifecycle` template (`StartDomainLifecycle`, method `DomainLifecycle`). Read literally, fungible mint would fail with `CAPABILITY_DENIED`, yet fungible mint worked live on sanctum in Aug 2026, so the deployed runtimes are newer. Where the code and live behaviour disagree, trust live behaviour on your instance and verify with a test transaction polled to completion.

Contents
1. Component map
2. Topology diagrams (federation view and inside one instance)
3. The units-api request pipeline
4. End-to-end data flows
   - 4a Mint / domain lifecycle
   - 4b Federated transfer saga, with compensation
   - 4c Login and signup
   - 4d Proof batching
5. Federation model
6. Messaging: Kafka topics and the outboxes
7. Identity, keys and credentials
8. Environments and hostnames
9. Repository map
10. Database table ownership
11. Observability
12. Docs versus code: functional corrections
13. Architectural limits worth knowing
14. Where to look in code

---

## 1. Component map

| Component | Repo / path | Language / stack | Port(s) | Role |
|---|---|---|---|---|
| **units-api** | `units-api/` (Go module `app`) | Go 1.25, Fiber, GORM, Uber dig, zap, Viper | 3000 (`/v1/*`, `/health`, Swagger at `/v1/docs/`) | Public REST API. Handles envelope parsing, authentication (dev token and user JWT), scopes, rate limiting, OPA authorisation, JSON-schema validation and signature verification. Owns accounts, keys, classes, configs, programs, chain/wallet/adapter registries, terms, the workflow API, the operation planner and federation service, and the primitive outbox. Exposes ULIP peer ingress at `/v1/ulip/*` and internal callbacks at `/v1/internal/*`. **Owns the whole `units` DB schema** (Flyway). |
| **token engine** | `units-token-runtime/tokenEngine` | Rust, Tokio, rdkafka, sqlx, axum | 8080 (health) | Kafka consumer group `token-engine`. It is the **only writer of token state**. Its pipeline: idempotency check → load config, program and state → verify the commitment → envelope verification → validate → pre-hooks → `execute` → atomic persist (tokens, token_transactions, state_history, primitive_ops) → post-hooks → audit → signed completion callback. |
| **token programs** | `units-token-runtime/tokenPrograms/programs/*` | Rust crates behind the `TokenProgram` trait, statically compiled into the engine | — | `fungible`, `non-fungible`, `credential`, `stables`, `purpose-bound-voucher`, `loan-nft-program`, `loan-pool-nft-program`, `hello-token`. They self-register into `token_programs` at engine boot. |
| **units-workflows** | `units-workflows/apps/*` | TypeScript Turborepo, Restate SDK, Prisma, Zod | 9080 (gateway) | One image whose `WORKFLOW_NAME` selects the app: **`gateway`** (hosts and registers everything), **`primitive-operation`** (the generic saga engine: plan steps, ULIP calls, durable promises, compensation), **`delegation`** / `delegation-revoke` (7-day approval timer, registry approve/reject/revoke, fan-out reconcile), **`profile-update`** (OTP-gated account changes). |
| **Restate server** | restatedev | — | 8080 ingress, 9070 admin | Durable execution runtime. units-api starts, signals and queries workflows through the ingress. |
| **units-registry** | `units-services/registry` | Go, Fiber, GORM | 3000 | Central federation registrar. Holds signed NameRecords, contact resolution, the instance catalog with capability documents, instance public keys, central OTP login, developer clients and keys (authoritative), the scope catalogue and `scope_apis`, rate tiers, delegations and OIDC clients. |
| **proofService** | `units-services/proofService` | Rust, axum, sqlx, rs_merkle + BLAKE3 | 8081 (`/v1/health` only) | Background batcher that turns completed transactions into BLAKE3 Merkle batches in `proofs`. The read and verify API is on units-api. **No chain anchoring.** |
| **notificationService (otp-service)** | `units-services/notificationService` | Node/Express, Twilio Verify, SendGrid | 4000 (local) | `POST /api/v1/otp/generate|verify`. Issues a signed OTP-JWT (`iss otp-service`). Mock mode uses a fixed OTP `123456` (non-prod). Publishes `/.well-known/ulip.json` keys. **This is not a webhook or event service.** |
| **adapterOrchestrator** | `units-services/adapterOrchestrator` | Go, Fiber | 8090 | Reverse proxy that routes `POST /*` to a chain adapter by `context.chainId` through `adapter_registry`. No timeout or failover. |
| **keycloakDelegatedAuth** | `units-services/keycloakDelegatedAuth` | Java 17 Keycloak SPI (`delegate-to-app`) | — | "Login with Finternet". Keycloak stays the OIDC authorization server for third-party relying parties, while login and consent UX happen in finternet-app. Not enabled by default. |
| **chain adapters** | `units-adapters` (image `alchemy-chain-adapter`) | — | 3500 | Chain-adapter API (`/api/v1/chain-adapter/{accounts/holdings, balance/get, transactions/build|submit|status}`) for about 20 EVM mainnets, about 10 testnets and Solana via Alchemy. |
| **Keycloak** | Keycloak | Java | 8080, path `/auth` | Issues end-user sessions: user JWTs come from realm **`finternet`**. Developer service accounts (`sa-<uuid>`) are managed by the registry. Not exposed to integrators. |
| **Vault** | HashiCorp Vault | — | 8200 | Custodies keys: account PII encryption keys and per-account Ed25519 signing keys (server-custodied DID key, `/v1/account/sign`). |
| **PostgreSQL / YugabyteDB** | — | Postgres (local) | — | Databases: `units` (units-api schema; roles also used by the engine and workflows), `registry`, `keycloak`, `app_backend` (finternet-app Prisma), `silence_labs` (MPC), plus small per-service DBs. |
| **Kafka** | — | — | 9092 | Internal command bus between units-api and the engine. Integrators never see it. |
| **MinIO / GCS** | — | — | — | Object storage (MinIO locally, cloud object storage in hosted environments) for credential images and large blobs. DID documents are now generated on the fly. |
| **finternet-app** | `finternet-app/` | Next.js 15 / React 19 UI + Express BFF, Prisma, pnpm/Turbo | 3002 UI, 6000 BFF | End-user web app: OTP and SSO signup, home-instance picker, tokens, transfers, KYC journeys (Signzy, SumSub → credential token), MPC wallet and WalletConnect, terms consent, **API Access → Clients**, super-admin approvals. The BFF has a deny-by-default allowlist proxy, injects the dev token, and routes your session to your home instance. |
| **WPBE (wpbe-silentlabs)** | Silence Labs wallet-provider backend | — | 8090 | MPC key generation and signing, plus a passkey WebSocket. Used by finternet-app. |
| **units-mcp** | image `units-mcp` | — | 3000 (`/mcp`) | MCP server that lets AI agents call units-api. |
| **OTel collectors + ClickStack/HyperDX** | — | — | 4317/4318 OTLP | Traces, logs and metrics from every service. |

Languages at a glance: **Go** (units-api, registry, adapter orchestrator), **Rust** (engine,
programs, proofService), **TypeScript** (workflows, finternet-app), **Node** (otp-service), **Java** (Keycloak SPI).

---

## 2. Topology diagrams

### 2.1 Federation view

```
                          ┌────────────────────────────────────────────────────────────┐
   Browser / end user ───▶│          CENTRAL REGISTRY "instance" (registrar)            │
   (my./sanctum./foundry.)│  finternet-app (UI + BFF)   units-registry                  │
                          │  otp-service                                                │
                          │  DBs: registry, app_backend                                 │
                          └────────┬────────────────────────────┬──────────────────────┘
          REST: /v1/instances,      │  ULIP /ulip/v1/* (Ed25519   │ capability publish,
          /v1/names, /v1/resolve,   │  envelopes): RegisterName,  │ name migration
          /v1/oidc/*                │  credential/resolve, scope/ │ (signed envelopes)
                                    │  catalog, delegation/*, ... │
              ┌─────────────────────┴───────────┐        ┌────────┴──────────────────────────┐
              │ UNITS INSTANCE A (home of alice) │◀ULIP──▶│ UNITS INSTANCE B (home of bob)    │
              │ full transaction stack (2.2)     │ /v1/   │ full transaction stack (2.2)      │
              │ units-api · engine · Restate ·   │ ulip/* │                                   │
              │ Kafka · DB · Vault · Keycloak    │        │                                   │
              │ (realm finternet)                │        │                                   │
              └──────────────────────────────────┘        └───────────────────────────────────┘

 Today every public environment is FLAT: the registry and ONE instance run together (the registrar
 is co-located). Multi-instance federation has been built and tested with two instances, but it is
 not the live topology.
```

### 2.2 Inside one instance

```
 Integrator backend / finternet-app BFF
        │ POST /v1/...  {context{id,version,ts,msgId,developerToken,authorization?}, payload, signature?}
        ▼
 ┌────────────────────────────── units-api (Go/Fiber :3000) ─────────────────────────────────┐
 │ middlewares: OTel → correlationId → logger → helmet → recover → apiID → parseEnvelope      │
 │   → SA auth (devToken → registry credential/resolve, cached briefly, fail closed)          │
 │   → SA scope (scope_apis) → rate limit → Keycloak JWT → user scope                         │
 │   → signature (transact) → JSON schema                                                     │
 │ services: account · token · tokenClass · config · program · delegation · terms ·           │
 │           federationService + operationPlanner → PrimitivePlan ; primitiveOutbox           │
 │ authz: embedded OPA rbac.rego (owner / class-manager / identity-view / delegations)        │
 └───┬────────────┬─────────────┬──────────────┬──────────────┬─────────────┬─────────────────┘
     │ Keycloak   │ Vault       │ DB `units`   │ Restate      │ registry    │ adapter-orchestrator
     │ (user      │ (PII,       │ (Postgres)   │ ingress      │ (creds,     │ → chain adapters
     │ sessions)  │ signing)    │              │              │ names, deleg)│ (holdings, chain tx)
     │            │             │              ▼              │             │
     │            │             │   ┌───────────────────────┐ │             │
     │            │             │   │ units-workflows        │ │             │
     │            │             │   │ primitive-operation    │─┘ ULIP to peers/registry
     │            │             │   │ delegation / revoke    │
     │            │             │   │ profile-update         │──▶ otp-service
     │            │             │   └──────────┬────────────┘
     │            │             │   writes primitive_ops via units-api internal APIs
     │            │             ▼              │
     │            │   primitive outbox ───────▶ Kafka `units.token.operations` (key = txId)
     │            │                                   │
     │            │                                   ▼
     │            │                   ┌────────────────────────────────┐
     │            │                   │ token engine (Rust)             │──▶ DLQ `units.token.operations.dlq`
     │            │                   │ programs + hooks, single writer │──▶ audit `units.token.events` (off by default)
     │            │                   └──────┬─────────────────────────┘
     │            │                          │ one SQL tx: tokens + token_transactions + state_history + primitive_ops
     │            │                          │ then signed POST /v1/internal/primitives/complete
     │            │                          ▼
     │            │                   units-api → signal Restate `primitiveCompleted` (signal outbox)
     │            ▼
     │       proofService (Rust) ── polls completed txs ── BLAKE3 Merkle batch ── `proofs`
```

---

## 3. The units-api request pipeline

Every business endpoint is `POST /v1/...` with `Content-Type: application/json`. About 100 routes, all POST except roughly 8 GETs.

1. **Parse the envelope.** `context` is `additionalProperties:false`, so any unknown key returns `400 INVALID_INPUT`. The required fields are `id`, `version` ("1.0", with "v1" also accepted live), `ts` (RFC3339) and `msgId` (a fresh UUID per attempt).
2. **Authenticate the service account.** The step computes `sha256(clientId:secret)` from `context.developerToken` and resolves it against the registry, which returns a registrar-signed bundle `{client_id, owner_addresses, scopes, allowed_operations, is_super_admin, rate_limit_tier_id}` valid for about 10 s. An unknown token gives 401 and an unreachable registry gives **503**. **The `Authorization` header is never read.**
3. **Check the SA scope.** The API id maps to a scope through `scope_apis`. An unmapped id gives `500 SCOPE_MAPPING_NOT_CONFIGURED`, and a missing scope gives `403 CLIENT_INSUFFICIENT_SCOPE`.
4. **Rate limit.** A sliding window per client tier and scope pattern. Over the limit returns 429 with `Retry-After`.
5. **Authenticate the user.** `context.authorization: "Bearer <Keycloak JWT>"`. The OTP-JWT is accepted only on login and create.
6. **Check the user scope**, where enabled.
7. **Verify the signature** on `/v1/token/transact`. The check is a raw Ed25519 signature over `JCS(payload)` using the registered key `signature.keyId`. Some checks are environment-dependent (for example transact signature enforcement), so always build signing in.
8. **Validate the JSON schema** per endpoint (`src/schemas/definitions/*.json`).
9. **Resource authorisation** through OPA. The owner can do everything. Any identity on the token can view. Delegations match by label and permission, and a deny overrides an allow.
10. **Service logic.** Synchronous endpoints (accounts, registry, configs, delegations reads) answer directly. Token writes become a **PrimitivePlan** started on Restate, and the API returns `{txId, status:"submitted", …}` immediately (HTTP 200 `successful` for mint/add, 202 `accepted` for transact).

The response envelope is `{"context":{…,"status":"successful|accepted|failed","error"?:{"code","message"}},"response":{…}}`.
A call succeeded only if the HTTP status is 2xx **and** `context.status != "failed"`.

---

## 4. End-to-end data flows

### 4a. Mint / domain lifecycle (`/v1/token/mint`, non-transfer transacts)

```
Integrator                units-api                          Restate primitive-operation      Kafka / engine                 DB
   │ POST /v1/token/mint     │                                         │                            │                         │
   │ {tokenClass,            │ auth/scope/JWT/schema                   │                            │                         │
   │  initialSupply,...} ───▶│ authz: caller ∈ class.identities(issuer)│                            │                         │
   │                         │ (list issuers in class identities)      │                            │                         │
   │                         │ federationService.StartDomainLifecycle  │                            │                         │
   │                         │ planner → domain_lifecycle@2.0          │                            │                         │
   │                         │ INSERT transactions(status pending,     │                            │                         │
   │                         │        status_v2 submitted)             │                            │                         │
   │                         │ StartWorkflow(primitive-operation,      │                            │                         │
   │                         │   key = txnId, {plan}) ────────────────▶│ create workflows row       │                         │
   │◀─ 200 {txId,            │                                         │ step 1 DomainLifecycle     │                         │
   │   status:"submitted",   │◀──── ULIP DomainLifecycle (local) ──────│ (signed envelope)          │                         │
   │   estimatedCompletion}  │ admit primitive_ops(txn_id, op_seq=1)   │                            │                         │
   │                         │ outbox → produce TokenOperationMessage ────────────────────────────▶│ consume (sequential)    │
   │                         │   {operation:"domain_lifecycle",        │                            │ idempotency (primitive_ │
   │                         │    payload{operation:"mint",...},       │                            │   ops engine_status)    │
   │                         │    opSeq, callerInstance, workflowId,   │                            │ load config → program   │
   │                         │    requestEnvelope, completionTarget}   │                            │ standard whitelist      │
   │                         │                                         │                            │ capability gate         │
   │                         │                                         │                            │ unwrap → inner "mint"   │
   │                         │                                         │                            │ validate → pre-hooks    │
   │                         │                                         │                            │ program.execute         │
   │                         │                                         │                            │ ONE SQL TX ────────────▶│ tokens, token_transactions,
   │                         │                                         │                            │                         │ state_history, primitive_ops
   │                         │                                         │                            │ post-hooks, audit       │
   │                         │                                         │                            │ transactions → completed│
   │                         │◀── signed POST /v1/internal/primitives/complete ─────────────────────│ (+affectedTokenIds)     │
   │                         │ record completion; backfill tokenId     │                            │                         │
   │                         │ signal outbox → primitiveCompleted ────▶│ resolve promise            │                         │
   │                         │                                         │ status COMMITTED            │                         │
   │ POST /v1/transaction/status {txId} (poll 1s → backoff) ◀── completed | failed{error{code,message}}                        │
   │ POST /v1/transaction/get → metadata.token_id / metadata.affectedTokenIds                                                  │
```

Notes:
- The mint response carries **no tokenId**. Find it with `/transaction/get`, or with `/token/search` sorted by `createdAt desc`.
- Most validation errors only appear when you poll: `UNSUPPORTED_TOKEN_STANDARD`, `CAPABILITY_DENIED`, `INVALID_PAYLOAD`, hook failures (`MAX_SUPPLY_EXCEEDED`, `MIN_BALANCE_VIOLATED`), `primitive_capability_missing`.
- The engine **rejects any state-changing message without federation context** (`opSeq>0` and `callerInstance`). Direct Kafka publishing is not a supported path.
- For fungibles, a second mint to the same owner and class **adds supply to the existing row**.
- Loan and pool operations go through the same path (`domain_lifecycle` with the inner verb, for example `loan_disbursed`). Loan and pool non-create operations require `tokenId`.

### 4b. Federated transfer saga (`/v1/token/transact {operation:"transfer"}`)

Recipe **`two_party_prepare_commit@2.0`**. It is the same whether source and destination are on one instance or on two. On a single instance both roles route to the local units-api.

```
 opSeq  method          callee        effect                                              status after
 ─────  ──────────────  ────────────  ──────────────────────────────────────────────────  ────────────
   1    Lock            source        balance−locked ≥ v ? push LockState{txn,1,v}         (SUBMITTED)
   2    CreateIncoming  destination   verify proofOfLock envelope; push IncomingState      PREPARED
   3    CommitDebit     source        drain lock: balance −= v   ◀── POINT OF NO RETURN    COMMITTING
                                      (prune opSeq 1 row best-effort, op 901)
   4    CommitCredit    destination   verify commitProof; consume incoming: balance += v   COMMITTED
                                      (prune opSeq 2 row, op 902)
```

```
                        ┌──────────── failure BEFORE PONR (steps 1–2, or 3 rejected pre-dispatch) ───────────┐
                        │  run prepareFailure compensations (only for steps that completed):                  │
                        │    102 RejectIncoming @destination   101 Unlock @source                             │
                        │  → ABORTED   (nothing moved)                                                        │
 SUBMITTED ─▶ PREPARED ─┤                                                                                     │
                        │ ─▶ COMMITTING ─▶ COMMITTED  (happy path)                                            │
                        │                                                                                     │
                        └──────────── failure AFTER PONR (step 4 timeout / failure / retry exhaustion) ───────┘
                             AUTO_REVERSING → query destination status (/v1/internal/transactions/destination-status)
                               COMMITTED      → COMMITTED (credit actually landed)
                               NOT_COMMITTED  → 201 Credit @source (reversal) + 202 RejectIncoming @destination → REVERSED
                               UNKNOWN        → STUCK  (manual operations)
```

Mechanics:
- **Routing.** units-api resolves the recipient (`to` is a plaintext address) to its home instance through the registry, snapshots the route, participants (role, DID, address, instance) and assetSelector, and computes a **planHash**. The destination recomputes it, and a mismatch is rejected.
- **Each step** is one ULIP call `POST {endpoint}/v1/ulip/<Method>`, signed with the calling instance's Ed25519 key. The callee writes `primitive_ops(txn_id, op_seq)` (idempotent), and the outbox publishes to Kafka. The engine executes and POSTs a signed completion. units-api then signals the workflow's durable promise `primitive:<txnId>:<opSeq>`. The default per-step timeout is 30 s. Commit steps have a retry policy (5 attempts, exponential backoff, up to 5 min).
- **Proofs between steps.** CreateIncoming carries the base64 Lock envelope (`proofOfLock`) and CommitCredit carries the CommitDebit envelope (`commitProof`). The engine's envelope-verification hook checks them.
- **Status views.** `/v1/transaction/status {txId}` returns `submitted…completed|failed`, while `/v1/transactions/status {"txn_id"}` is the SA-level federation status view with lifecycle and per-op details (`workflow_ops`). Integrators should use `/v1/transaction/status`.
- **Constraints.** NFT `value` must be `"1"`. CREDENTIAL, UNITS-Loan and UNITS-LoanPool are not transferable. A voucher needs `category`, a transferable class and `voucherTransfer.enabled`. Same-instance NFTs can use `local_transfer`.
- **Proxy assets** use `proxy_record@2.0` (RecordProxyEntry → Debit → RecordProxyEntry → Credit). It can stop at `awaiting_signature` with an unsigned chain transaction, and it has **no compensation policy**.
- **Live caveat (sanctum, Aug 2026).** Fungible transfer returned `recipient_address_not_found` for every recipient. This is an open issue.

### 4c. Login and signup

**Direct API (what integrators call):**

```
1. POST /v1/account/login {username: email|E.164 phone}           → OTP sent (sandbox OTP 123456 in non-prod mock mode;
                                                                    send-otp may still reach a real inbox/phone)
2. POST /v1/account/login {username, otp}
      units-api → otp-service verify → OTP-JWT
        existing account → Keycloak session issued
                         → {accessToken, tokenType:"Bearer", expiresIn≈36000, refreshToken, refreshExpiresIn≈1800, isExisting:true}
        no account       → {accessToken = OTP-JWT, isExisting:false}
        homed elsewhere  → 409 FORWARD
3. (new) POST /v1/account/create  context.authorization="Bearer <OTP-JWT>"
        payload {address, name, entityType: PERSONAL|BUSINESS}
      units-api: create Vault transit signing key (DID = did:units:0x<pubkey>) → RegisterName at registry
                 (ULIP, synchronous) → Keycloak user → accounts row (PII encrypted)
      → real session {accessToken, refreshToken, ...}
4. Keep alive: POST /v1/account/refresh {refreshToken} on a timer < 30 min, single-flight lock
      (refresh tokens are single-use; reuse → SESSION_REVOKED). /v1/account/logout = logout everywhere.
```

**Federation "OTP-first" flow (finternet-app, ADR-007):**

```
Browser → BFF → registry POST /v1/account/login {username}         → OTP via otp-service (central)
Browser → BFF → registry POST /v1/account/login {username, otp}    → {is_existing, home_instance, did,
                                                                      access_token = OTP-JWT, instances[]}
  existing: BFF → home units-api /v1/account/login (OTP-JWT fast path) → Keycloak JWT
  new:      pick an instance with accepts_new_signups → /v1/address/checkAvailability → /v1/terms/get
            → home units-api /v1/account/create {address, name, entityType, homeInstance}
            → /v1/terms/accept (terms_of_use, privacy)
Subsequent calls: the portal routes your session to your home instance
                  (unresolvable instance → 401 FED_INSTANCE_UNRESOLVED).
```

Google SSO in the app: the BFF verifies the Google id_token, mints a ≤300 s `authToken`
(`iss finternet-app-bff`), resolves the home instance through registry `/v1/resolve`, and calls
`/v1/account/login {username, authToken}`.

### 4d. Proof batching

```
every MERKLE_POLL_INTERVAL_SECS (30–60 s):
  BEGIN
    SELECT … FROM transactions WHERE proof_id IS NULL AND status='completed'
      ORDER BY created_at LIMIT MERKLE_BATCH_SIZE FOR UPDATE
    if rows < MERKLE_BATCH_SIZE → ROLLBACK, wait     ◀── no time-based flush: quiet envs stay "pending"
    SELECT value-moving token_transactions (commit_credit, commit_debit, credit, debit) FOR UPDATE
    leaf = BLAKE3(compact JSON, sorted keys, timestamps normalised to µs)    (one leaf per transaction)
    root = Merkle(BLAKE3)            → INSERT proofs{proof_profile:"merkle-tree", proof_data{algorithm, merkleRoot,
                                        leaves[{txId, leafIndex, leafHash, proofPath[{hash,direction}], leafData}]},
                                        state_commitment: root, batch_id, tx_ids, ledger_anchors: NULL, status:"proven"}
    UPDATE transactions/token_transactions SET proof_id, batch_id
  COMMIT
```

The FOR UPDATE locks stop `PruneTokenTransactions` from deleting rows while they are being hashed.

Read side (units-api):
- `/v1/transaction/proof {txId}` returns the batch.
- `/proof/leaf` returns the leaf data, so you can check that `BLAKE3(jq -S -c .response) == leafHash`.
- `/proof/verify` recomputes the Merkle path. It is **structural only**: no on-chain anchor and no operator signature.

The per-token commitment chain in `state_history` is separate. It is written synchronously on every
state change, independent of batching.

---

## 5. Federation model

| Concept | How it works |
|---|---|
| **Instance** | A full transaction stack identified by an immutable UUID `instance_id` (never change it once registered), a display name, `api_url`, `ulip_url`, `well_known_url` and an Ed25519 ULIP signing key (`ed25519-key-1`). |
| **Home instance** | Each account has exactly one, recorded in its registry NameRecord and carried in the session. All of the account's tokens and history live there. Logging in at another instance returns `409 FORWARD`. Migration uses a dual-signed claim plus **forwarding pointers**. |
| **Registry / registrar** | A central Go service (`units-registry`). It signs records with the registrar Ed25519 key (`registrar-key-1`, namespace `registrar.finternet.lab`). The trust anchor is published at `GET /v1/.well-known/registrar-pubkey` and `/.well-known/jwks.json`. Clients pin it (`REGISTRAR_PUBKEY`) or use TOFU. It stores only routing metadata and hashes, never token data. |
| **NameRecord** | `{address, did, home, home_endpoints{api_url, ulip_url}, name, user_public_key, email_hash, phone_hash, version, as_of, signed_by, key_id, signature}`, signed over the JCS body. Collision rules: a name held by another DID gives `409 NAME_TAKEN`, and a contact held by another DID gives `CONTACT_TAKEN`. |
| **ULIP** | Signed envelopes: `context{ulip_version:"v1", method, txn_id, op_seq, caller_instance, callee_instance, sent_at}` + `payload` + `signature{signer_instance, key_id, algorithm:"ed25519", signature}`. The signing input is `JCS(context) ‖ JCS(payload)`. Peer ingress is units-api `/v1/ulip/<Method>`, and registry methods are `/ulip/v1/*`. Verification fails closed. The registry's "hardened" routes also gate on audience (`callee == registrar namespace`) and freshness (120 s skew). Replay protection: `request_log(caller_instance, txn_id)` at the registry, and `primitive_ops(txn_id, op_seq)` at instances. |
| **Capability document** | An instance self-signs and publishes a capability document to the registry. It covers ULIP versions, programs and asset models, primitive methods, operation templates, token classes accepted and issued, supported chains, the signup flag, peering policy, endpoints and signing keys. Peers read it via `POST /ulip/v1/capabilities` or `GET /v1/instances/:id`. |
| **Developer credentials** | These are federated. The registry is authoritative for clients, keys (hashes only), scopes and rate tiers. Every instance resolves dev tokens live through `credential/resolve`. Creating a client requires an owner-signed inner envelope. |
| **Delegations** | Federated. Stored in the registry. Grants and revokes fan out (`/v1/internal/delegation/reconcile`) to each instance, which restamps `access` identities on matching tokens. Fan-out fails closed (Restate retries). |
| **What stays per instance** | Token classes, configs, programs, tokens, transactions, chain/wallet/adapter registries, terms. A class code must be unique within its own instance, and its availability elsewhere is advertised only through capability documents. |

---

## 6. Messaging: Kafka topics and the outboxes

| Topic | Producer → consumer | Key | Notes |
|---|---|---|---|
| `units.token.operations` | units-api primitive outbox (and engine secondary operations from post-hooks) → engine group `token-engine` | `txId` | Main command topic. Because the key is the txId and not the token, **there is no per-token ordering**. Correctness relies on optimistic locking and retries. |
| `units.token.operations.dlq` | engine → (operators) | `partition:offset` | Messages that exhaust retries (3 attempts total for retryable errors). Program errors are not retried. |
| `units.token.events` | engine → (none by default) | `event_id` | Audit stream. `auditEnabled` defaults to false. Some global configs call it `units.token.operations.audit`. |

Outboxes (in units-api `primitive_ops`, where each column group has exactly one writer):
- **gateway dedup** (A): admit or deny by `(txn_id, op_seq)` and request hash.
- **command outbox** (B): leased, batched delivery to Kafka, retried forever. Stuck rows log `outbox_delivery_stuck`.
- **engine result** (C): `engine_status`, `engine_result`, written in the same SQL transaction as the state change.
- **completion outbox** (D): the engine's signed callback to `completionTarget`, polled every 5 s with exponential backoff.
- **signal outbox** (E): units-api → Restate `primitiveCompleted`.

**There is no external event bus and there are no webhooks.** Integrators poll.

---

## 7. Identity, keys and credentials

| Credential | Issuer | Where it travels | Lifetime |
|---|---|---|---|
| Developer token `base64("sa-<uuid>:<secret>")` | Registry | `context.developerToken` on every call | Until rotated or deactivated. Rotate with `graceSeconds`. Deactivation takes effect in ≤15 s. |
| User access token (JWT) | Keycloak realm `finternet`, issued through units-api login | `context.authorization: "Bearer …"` | About 10 h observed (capped by SSO max). Refresh idle 30 min, single-use. |
| OTP-JWT | otp-service (RS256/EdDSA, `iss otp-service`) | `context.authorization` on `/account/create` only | Short |
| SSO authToken | finternet-app BFF (`iss finternet-app-bff`) | `payload.authToken` on login/create | ≤300 s (600 s max) |
| Envelope signature `{keyId, jws}` | User's ed25519 key (wallet or Vault-held via `/v1/account/sign` after OTP) | `signature` in the request body | Per request |
| ULIP instance key | Per instance (`ed25519-key-1`) | ULIP envelopes, engine completion callbacks | Long-lived (rotation planned) |
| Registrar key | Registry (`registrar-key-1`) | NameRecords, credential bundles | Long-lived |

Keys are custodied in Vault (account PII encryption keys and server-custodied Ed25519 signing keys).
Secret values never appear in repos or in this skill.

---

## 8. Environments and hostnames

| Env | Web app (UI) | UNITS API base | Registry | Notes |
|---|---|---|---|---|
| dev ("Foundry") | `foundry.finternetlab.io` | `https://units.foundry.finternetlab.io` | internal only | May be unavailable. |
| staging ("Sanctum", integrator sandbox) | `sanctum.finternetlab.io` | `https://units.sanctum.finternetlab.io` | `registry.sanctum.finternetlab.io` | Available about 08:00–21:00 IST on weekdays. Sandbox OTP `123456` (non-prod only; send-otp may still email or SMS a real address). |
| prod | `my.finternetlab.io` | `https://units.finternetlab.io` | `registry.finternetlab.io` | Production may run an older build than sandbox; re-test environment-dependent behaviour. The prod app ships SSO-only. |
| local | `http://localhost:3002` (app) | `http://localhost:3000` | `http://localhost:3100` (overlay) | Docker-compose stacks per repo. |

- Public docs say environment base URLs are "to be disclosed" and give examples with a placeholder host. **Do not invent other hosts.**
- The health check is `GET /v1/health` (docs). The service also exposes `/health`.

---

## 9. Repository map

Each repo has a `CLAUDE.md` (agent manual). Several are partly stale, so treat the code as the truth.

| Repo | Owns | Language | Key directories | Agent docs / caveats |
|---|---|---|---|---|
| **units-api** | Public API, auth/authz, planner, federation service, outboxes, ULIP peer ingress, **all `units` DB DDL** | Go 1.25 (module `app`) | `src/routers/` (one file per domain: token, token_class, token_class_config, token_program, account, key_*, delegation, workflow, federation, ulip_primitives, proof, terms, scope*, registry, adapter_registry, api_client), `src/services/` (token.go, federation.go, operation_planner*.go, primitive_outbox.go, workflow_execute.go), `src/middlewares/`, `src/authz/policies/rbac.rego`, `src/schemas/definitions/*.json`, `src/providers/{auth/keycloak,crypto/vault,database,storage}`, `src/clients/restate_client.go`, `specs/db/V01…V15`, `specs/api/*.yaml`, `manifests/docker-compose/`, `tests/e2e/`, `docs/adr/` | `CLAUDE.md`, `AGENTS.md`. Its "Bootstrap" section (`/v1/api-clients`, hashed API keys) is **stale**. The current API is `/v1/clients/*` with registry-resolved SA tokens. |
| **units-token-runtime** | Token engine and all token programs | Rust | `tokenEngine/src/{kafka,engine/{executor.rs,hook_runner.rs,hooks/},db}`, `tokenPrograms/{interface,registry,programs/{core,fungible,non-fungible,credential,stables,purpose-bound-voucher,loan-nft,loan-pool-nft-program,hello-token}}`, `specs/db/` (copies), `scripts/` | `CLAUDE.md` plus program docs. Many still say `reference-ft` / an `OperationType` enum / single-message transfer, all **stale**. |
| **units-workflows** | Restate workflows | TypeScript (Node ≥24), Turborepo | `apps/{gateway,primitive-operation,delegation,profile-update}`, `packages/{http-client,workflow-utils (ULIP signing, JCS, registry client),workflow-db,db,restate-utils,otel,validators}`, `specs/db/` | `CLAUDE.md` is stale: it lists only gateway and profile-update, and Node ≥20. Removed apps: transfer, signup, scope-approval. |
| **units-services** | Registry, proofService, notificationService (otp), adapterOrchestrator, keycloakDelegatedAuth | Go, Rust, Node, Java | `registry/{src,specs/db V01…V13,seed}`, `proofService/src`, `notificationService/`, `adapterOrchestrator/`, `keycloakDelegatedAuth/`, `specs/db/registry.sql` (adapter_registry) | `CLAUDE.md` is partly stale (proof endpoints moved to units-api, registry omitted). The registry README "Phase 1 scaffold" note is outdated. |
| **specs** | Public OpenAPI contracts and JSON-LD schemas | YAML / JSON-LD | `api/*-interfaces.yaml` (accounts, clients, delegations, key-management, token, token-class-config, token-program, scopes, terms, workflows, registry, central-registry, adapter-interface), `schemas/{core,account,token,token-class,credential,transaction}` | Two incompatible token models coexist. The API matches the five-section model. CI checks syntax only. |
| **docs.finternetlab.io** | Public GitBook docs | Markdown | `documentation/{overview,concepts,building,use-cases,architecture,reference}`, `api-reference/`, `changelog/` (release notes, roadmap), `help/` | Some pages lag the code (see §12). Uses "Foundry" naming. |
| **finternet-app** | End-user web app and BFF | TypeScript, Next.js 15, Express, Prisma, pnpm | `apps/app` (UI), `apps/server` (BFF), `modules/{proxy,oidc,oauth,credentials,wallet,db}`, `packages/{instance-routing,config,types,…}`, `config/defaults.yaml` (proxy allowlist), `docs/adr/` | `CLAUDE.md` overstates what `pnpm docker-up` starts. The checkout may be pinned to a release tag behind `main`. |

---

## 10. Database table ownership

**units-api owns and migrates the whole `units` schema** (Flyway). The engine and workflows connect
with their own roles and write only within agreed column groups. The schema has no foreign keys.

| Table | DDL (units-api) | Written by | Purpose |
|---|---|---|---|
| `accounts` | V01 | units-api | Accounts (address, hashed identity, DID, entity type, encrypted PII, vault entity) |
| `key_references` | V01 (+V14/V15) | units-api | Registered and managed keys, wallet addresses (absorbed the old local `public_key_registry`) |
| `token_classes` | V02 | units-api | Class definitions (code is globally unique, standard, schema, identities, metadata, chain_deployments) |
| `tokens` | V02 | **engine only** | Token state rows (identities, relationships, data, state, commitment, version, proxy chain fields) |
| `transactions` | V02 | units-api (create, `status_v2`), engine (`status`, error, metadata), proofService (`proof_id`) | Async unit of work |
| `token_transactions` | V02 | engine (prune via units-api ULIP) | Double-entry per-token rows with before/after |
| `state_history` | V02 | engine | Version snapshots and commitment chain |
| `proofs` | V02 | proofService | Merkle batches (`ledger_anchors` always NULL) |
| `audit_events` | V02 | engine | Audit per affected token |
| `token_programs` | V03 | engine (self-register at boot), units-api (register endpoint) | Program catalog with capabilities and plans |
| `token_class_configs` | V03 | units-api | Class → program binding, hooks, config |
| `chain_registry`, `wallet_provider_registry`, `adapter_registry` | V04 | units-api (registry endpoints), seeds | Per-instance chain, wallet and adapter catalogs |
| `workflow_registry` | V05 | units-api (`/v1/internal/workflows/register`) | Registered workflow definitions |
| `workflows` | V06 | units-workflows | One row per workflow run (federation lifecycle) |
| `forwarding_pointers` | V07 | units-api | Migrated-account pointers |
| `workflow_ops` | V08 | units-api (via workflows) | Per-primitive audit (request/response hashes) |
| `primitive_ops` | V09 | units-api (A, B, E), engine (C, D) | Dedup plus outboxes keyed `(txn_id, op_seq)` |
| `terms_versions`, `user_consents` | V12 | units-api | Terms and consent |

Registry DB (`units-services/registry/specs/db`, V01–V13): `accounts` (NameRecords keyed by address
hash), `registered_instances` (+capability), `public_key_registry` (instance keys), `request_log`,
`audit_log`, `developer_clients`, `developer_keys`, `scopes`, `scope_apis`, `rate_limit_tiers`,
`rate_limit_rules`, `delegations`, `oidc_clients`. API clients, keys and delegations **moved here from
units-api**, and a one-time import tool migrated them.

Other DBs: `keycloak`, `app_backend` (finternet-app: `integration_providers`, `provider_journeys`,
`user_passkeys`, `user_mpc_keys`, `user_wallet_links`), `silence_labs` (MPC), plus small DBs for the
adapter orchestrator, chain adapter and proof service.

---

## 11. Observability

- **OpenTelemetry everywhere.** units-api (otelfiber, metrics for API counts and latency, DB operations by table, outbound HTTP), the engine (`token_engine.*`, `token_program.*` metrics, span `process_token_operation`), workflows (`units_workflows.*`, HyperDX Node SDK), the registry (OTel plus Prometheus `registry_*`), otp-service and the BFF. Data goes over OTLP (4317/4318) to the collector and on to **ClickStack/HyperDX**.
- **Correlation.** units-api reads the optional **`X-Correlation-ID`** header (its only header) and propagates it as `correlationId` into `transactions.correlation_id`, Kafka messages and engine `ExecutionContext`. W3C `traceparent` / `traceContext` flows API → Kafka → engine and workflows → units-api. `context.msgId` is echoed back and logged. Quote it when you report problems. It is **not** an idempotency key, and neither is `correlation_id` (which is not unique).
- **Per-transaction forensics** (operators): `transactions` (status, error `{code,message,system}`, `metadata.affectedTokenIds`), `primitive_ops` (engine and completion status), `workflow_ops`, `state_history`, the DLQ.
- **Integrator-side**: log `msgId`, `txId`, HTTP status, `context.status` and `context.error` for every call. Poll `/v1/transaction/status` and `/v1/transactions/status`.

---

## 12. Docs versus code: functional corrections

Where public docs and code disagree on behaviour you build against, **code (and live behaviour) wins**.

| Documented / commonly assumed | Actual behaviour | What to do |
|---|---|---|
| Token classes are schema-validated | Mint accepts any JSON in `data`; class schemas are not enforced. | Validate `data` in your own backend. |
| ERC-20 / ERC-721 / ERC-3643 labels mean smart contracts | The labels select a Rust program and balance model. No smart contracts. | Treat standards as program selectors. |
| `operationOverrides` restrict operations | Stored, not enforced. | Don't rely on them. |
| Hook `config` (e.g. `{"limit":…}`) parameterises hooks | Hooks read class metadata (`maxSupply`, `minBalance`). | Put limits in class metadata. |
| Developer token / JWT can go in the `Authorization` header | Only `context.developerToken` / `context.authorization` are read. | Use the envelope fields. |
| Transfer is a single atomic DB transaction | A multi-step saga where each primitive is atomic, with compensation and an explicit STUCK state. | Poll to a terminal state. |
| Idempotency via transaction IDs | Engine primitives are idempotent on `(txn_id, op_seq)`. There is **no request-level idempotency**, so a duplicate POST gives a duplicate mint. | Dedupe on your business ids before retrying. |
| Per-token ordering (partition by token id) | Kafka key is txId. Same-token operations are guarded by optimistic version locking. | Serialise dependent operations on your side. |
| DID lookups / did:web documents | `did:units:0x…`, and the DID API endpoint is disabled. | Use `/v1/address/resolve`. |
| Webhooks / post-hook notifications to integrators | No webhook mechanism. | Poll. |
| Amounts validated positive and exact | Zero is accepted on plain fungible transfers, and excess decimals are truncated. | Validate amounts client-side. |
| Mint restricted to minting authorities | Enforced when class `identities` lists issuers. | Always list issuers on classes you create. |
| Search returns only tokens you own | Search covers tokens where the caller holds **any** identity, so an issuer keeps visibility after a sale. | Filter by owner where it matters. |
| Burn retires supply | A user burn returns units to the issuer pool; only an issuer burn reduces circulating supply. | Model retirement explicitly. |
| Batch / lot provenance through splits | Fungible mints and credits merge into one row per (owner, class). | Track lots in `data` or separate classes. |
| State commitments anchored to external chains | Merkle batching works; chain anchoring is on the roadmap. | Don't promise anchoring. |

Don't make claims about encryption at rest, anchoring or audit immutability to your users; confirm current guarantees with Finternet. Verifiers should validate credential provenance (expected token class, VC `issuer`, provider signature/evidence, and confirmation from the issuing provider) rather than relying on class membership alone.

**Safe to describe:** DID accounts with Keycloak OIDC and revocable, registry-resolved developer
credentials; governed issuance; quantity-conserving partial transfers through a durable two-phase saga
with compensation and an explicit STUCK state; integer-only arithmetic; a transactional outbox;
per-token snapshots and chained commitments written in the same transaction as the state change;
multi-token atomic commits; OPA/Rego delegations with deny shadowing; tenant-scoped history with date
range; BLAKE3 Merkle batching.

---

## 13. Architectural limits worth knowing

- **Asynchronous by design.** Every token write is eventually consistent. Budget seconds per operation, and more for cross-instance transfers. Never report success on a 202.
- **Registry dependency.** If the registry is unavailable, every authenticated call fails with 503 (fail closed).
- **The engine processes messages sequentially per replica.** Throughput is unbenchmarked, and no repo contains load tests or SLOs.
- **Programs are compiled in.** A new behaviour needs an engine release. A "stock domain-lifecycle guest" and WASM programs are proposals with no ADR.
- **Nothing runs on a clock.** Expiry, maturity, coupons and voucher validity happen only when a request touches the token. Restate timers exist only for delegation approval and OTP waits.
- **Proofs need traffic.** Merkle batches wait for a full batch, so on quiet environments `/proof` stays pending.
- **Prune versus immutability.** Prepare-phase rows are deleted after commit (best-effort, never on compensation paths).

---

## 14. Where to look in code (quick index for engineers)

Paths are relative to the root of each repo checkout. Line numbers drift, so search for the symbol.

| Question | Look at |
|---|---|
| Which routes exist, and which middlewares guard each one? | `units-api/src/routers/*.go` (one file per domain), `units-api/src/middlewares/` (`scope.go`, `signature.go`, `logger.go`, auth) |
| How is a developer token resolved? | `units-api/src/middlewares/auth.go`, `units-api/src/registry/`; registry side `units-services/registry/src` (`credential/resolve`) |
| Who may do what on a token (OPA)? | `units-api/src/authz/policies/rbac.rego`, `units-api/src/delegation/` |
| How a transact becomes a plan | `units-api/src/services/token.go` (`TransactToken`, `MintToken`), `services/federation.go` (`StartTransfer`, `StartDomainLifecycle`), `services/operation_planner_recipes.go` |
| Outbox delivery and stuck rows | `units-api/src/services/primitive_outbox.go` |
| ULIP peer ingress (Lock, CommitDebit, PruneTokenTransactions, Reconcile…) | `units-api/src/controllers/ulip_primitives.go`, `units-api/src/ulip/` |
| Amount parsing and decimals conversion | `units-api/src/utils/decimal.go` (`ValidateBaseUnitAmount`, `ConvertToBaseUnits`) |
| Request JSON schemas | `units-api/src/schemas/definitions/*.json` |
| DB DDL | `units-api/specs/db/V01…V15__*.sql` |
| The saga engine (steps, compensation, PONR, prune) | `units-workflows/apps/primitive-operation/src/`, `units-workflows/packages/workflow-utils` (ULIP client, JCS, signing) |
| Delegation approval and reconcile | `units-workflows/apps/delegation/src/`, units-api `handlers/delegation.go` |
| Engine pipeline, idempotency, persistence | `units-token-runtime/tokenEngine/src/engine/executor.rs`, `engine/hook_runner.rs`, `engine/hooks/` (commitment, envelope, audit), `kafka/{consumer,message}.rs` |
| Program trait and types | `units-token-runtime/tokenPrograms/interface/src/{traits,types,context,hooks}.rs` |
| Commitment hashing | `units-token-runtime/tokenPrograms/programs/core/src/commitment.rs` |
| A program's operations and validation | `units-token-runtime/tokenPrograms/programs/<program>/src/{program.rs,operations/*.rs}` |
| Program registration (what is compiled in) | `units-token-runtime/tokenPrograms/registry/src/registry.rs` |
| Merkle batching | `units-services/proofService/src/service/proof_generator.rs` |
| Registry NameRecords, capability docs, delegations, scopes | `units-services/registry/src/`, `units-services/registry/specs/db/` |
| BFF routing and allowlist | `finternet-app/config/defaults.yaml` (`proxy.allowlist`), `finternet-app/packages/instance-routing`, `finternet-app/modules/proxy` |
| KYC to credential token | `finternet-app/modules/credentials` |
| Public contracts | `specs/api/*-interfaces.yaml`, `specs/schemas/**` |
