# Workflows and services internals

This file covers the Restate workflows in `units-workflows`, the async plumbing in `units-api` (`primitive_ops` outbox, Kafka, completion callbacks), and the five services in `units-services`: registry, proofService, notificationService, adapterOrchestrator and keycloakDelegatedAuth. It's written for engineers working on that code. Snapshot 2026-10-03. Verify against code because things move.

Repo `CLAUDE.md` files are partly stale:
- units-workflows' file lists only gateway and profile-update, and says Node ≥20 (the real requirement is ≥24).
- units-services' file describes proof endpoints that moved to units-api, and omits the registry and keycloakDelegatedAuth.

> **There are no webhooks, SSE or event bus for integrators** anywhere in these repos. Kafka is internal (API → engine). Status is always pulled: `/v1/transaction/status`, `/v1/transactions/status`, `/v1/workflows/status`.

> **Ask before breaking contracts.** These are cross-repo, cross-instance contracts: the ULIP envelope or signing input, the `PrimitivePlan` shape (including the plan-hash rules), the completion callback body or signing input, the `TokenOperationMessage`, `workflow_registry`/`workflows`/`primitive_ops` DDL (owned by units-api Flyway), and registry record signatures. Ask whether in-flight workflows (Restate replays journals), older peer instances and existing signed records must keep working before you change them.

---

## 1. units-workflows overview

| Item | Value |
|---|---|
| Stack | TypeScript Turborepo, npm workspaces, Node ≥24, Restate SDK (`restatedev/restate:1.3` server), Zod, Prisma (two clients `@units/workflow-db`, `@units/db`), Jest (ESM), `tsx watch` |
| Apps | `gateway` (hosts all workflows), `primitive-operation`, `delegation` (+ `delegation-revoke`), `profile-update` |
| Removed (CHANGELOG 2026.07.06) | `transfer` (replaced by generic primitive-operation), `signup` (units-api registers names synchronously), `scope-approval` (synchronous registry write + registry expiry sweeper). `scripts/register-restate.sh` and compose comments still mention scope-approval on 9083. That's stale. |
| Packages | `http-client` (envelope-aware), `logger`, `otel`, `restate-utils`, `validators`, `workflow-db`, `workflow-utils` (ULIP calls, DID helpers, registry client), `db`, `typescript-config` |
| Image | Single `workflow-orchestrator` image. Entrypoint picks `apps/$WORKFLOW_NAME/dist/app.js` (default `gateway`). EXPOSE 9080. |
| Ports (defaults) | gateway 9080 (`PORT`), primitive-operation 9084, delegation 9081, profile-update 9080 |
| Restate endpoint | `startWorkflowEndpoint(services, port)` serves plain **h2c** (TLS terminates upstream). SIGTERM drains with a 10 s watchdog. |
| Error mapping | `toRestateError`: `HttpClientError` 4xx → `TerminalError` (not retried); anything else is retried by Restate |

**Gateway** (`apps/gateway/src/app.ts`) imports `@units/otel/register` first, then binds `[profileUpdateWorkflow, delegationWorkflow, delegationRevokeWorkflow, primitiveOperationWorkflow]`. It runs `[registerProfileUpdate, registerDelegation, registerPrimitiveOperation]` with `Promise.allSettled`: if all fail it exits, and partial failures only warn. If `RESTATE_ADMIN_URL` is set, it self-registers with Restate admin 1 s after start (`POST {admin}/deployments {uri: SELF_DEPLOYMENT_URI||http://localhost:PORT, force:true}`, 12 × 2 s). **Without a Restate deployment registration, ingress 404s every `/<service>/<id>/...` call.**

Because the gateway hosts every workflow, it needs every app's env:
- primitive-operation: `ULIP_BASE_URL`, `LOCAL_INSTANCE_ID` (UUID)
- delegation: `LOCAL_INSTANCE_ID`, `REGISTRY_BASE_URL`, `REGISTRAR_NAMESPACE`, `RECONCILE_PEER_URLS`, plus registry client settings
- signing: `ULIP_SIGNING_PRIVATE_KEY`, `ULIP_SIGNING_KEY_ID`
- shared: `WORKFLOW_API_URL`, `DEVELOPER_TOKEN`, `DATABASE_URL`, `OTP_SERVICE_URL`

Config is Zod-parsed lazily on first use, so a missing var fails at first call, not at boot.

### 1.1 How units-api talks to Restate (`units-api/src/clients/restate_client.go`, `RESTATE_INGRESS_URL`)

| Method | HTTP | Use |
|---|---|---|
| `StartWorkflow(name, id, payload)` | `POST {ingress}/{name}/{id}/run/send` | async start (fire and forget) |
| `RunWorkflowSync` | `POST {ingress}/{name}/{id}/run` | blocking |
| `SignalWorkflow(name, id, handler, payload)` | `POST {ingress}/{name}/{id}/{handler}/send` | deliver signal to a shared handler |
| `QueryWorkflow(name, id, handler)` | `POST {ingress}/{name}/{id}/{handler}` | e.g. `getStatus` |
| `CancelWorkflow` | Restate cancel | `/v1/workflows/cancel` |

`name` is the **Restate service name** (`workflow_registry.restate_service`): `primitive-operation`, `delegation`, `delegation-revoke`, `profileUpdate`. That isn't necessarily the registry `workflow_name` (`delegation-create`, `profile-update`).

---

## 2. Generic workflow API in units-api (`/v1/workflows/*`)

| Endpoint | api id | Payload (schema) | Semantics |
|---|---|---|---|
| `POST /v1/workflows/execute` | `api.workflow.execute` | `{workflow, action, data}` (all required) | Chain: envelope → SA auth → SA scope → rate limit → user JWT → user scope → consent → JSON schema → `WorkflowExecuteService.Execute` |
| `POST /v1/workflows/status` | `api.workflow.status` | `{workflowId}` | Derives the workflow name by stripping the trailing `-<uuid>` (37 chars) from the id, looks up the registry row, then `QueryWorkflow(restateService, id, "getStatus")` |
| `POST /v1/workflows/cancel` | `api.workflow.cancel` | `{workflowId, workflowName}` | Registry lookup → Restate cancel |
| `POST /v1/internal/workflows/register` | `api.internal.workflow.register` | `{workflowName, version, description?, config?, steps, jsonSchema, restateService}` | Upsert into `workflow_registry`. Called by each app's `register.ts` (SA auth only, no user JWT). |

`Execute(workflow, action, data, userJWT, initiatorClientId)` runs these steps:
1. `workflow_registry` row `WHERE workflow_name=? AND status='active'`, else 404.
2. `action` must be one of `steps[].name`, else INVALID_INPUT.
3. Validate `{action, data}` against the row's `json_schema`.
4. If a **domain action handler** is registered for `(workflow, action)` (`units-api/src/handlers/registry.go`), call it. That covers `profile-update`, `delegation-create`, `delegation-revoke` and `scope-approval`. Handlers can do all the work in-API without Restate (scope approval, delegation approve/reject/cancel are synchronous registry writes now).
5. Default routing:
   - `action == steps[0].name` → **start**: `workflowId = "{workflow}-{uuid}"`, inject `data.workflowId`, `data.userJWT`, `data.initiatorClientId`, `StartWorkflow`. Returns **202** `{workflowId, status:"accepted"}`.
   - Otherwise → **signal**: needs `data.workflowId`, handler name = `action`. Returns 200 with the Restate response or `{workflowId, action, status:"signaled"}`.

Note that `userJWT` is stashed in workflow input and replayed by Restate later. A long wait (profile-update OTP ≤10 min, delegation approval up to 7 days) can outlive the token. This is why the access-token lifespan cut (Phase 2 refresh tokens) is blocked.

### 2.1 `workflow_registry` (DDL owned by units-api `specs/db/V05__workflow_registry.sql`; seeds `scripts/seed/08-delegation-workflows.sql`, `11-scope-approval-workflows.sql`)

```sql
workflow_registry(id uuid pk, workflow_name varchar(100), version varchar(20), description text,
  config jsonb default '{}', steps jsonb not null,          -- [{name, description}], steps[0] = start action
  json_schema jsonb not null,                               -- validates {action, data}
  restate_service varchar(200) not null,                    -- Restate service name at ingress
  status varchar(20) default 'active' check (status in ('active','deprecated','disabled')),
  created_at, updated_at, unique(workflow_name, version))
```

Registered definitions:

| workflow_name | restate_service | steps | Notes |
|---|---|---|---|
| `primitive-operation` | `primitive-operation` | `run`, `getStatus` | schema `{action:"run", data:{plan:object}}`. units-api starts it directly, not through `/execute`. |
| `delegation-create` | `delegation` | `allow, deny, approve, reject, cancel` | allow `{grantee_address, label, permission ∈ view\|transact\|manage, expires_at?, allowedOperations?}` (`allowedOperations` is read by the units-api handler, not the row schema). approve/reject/cancel `{delegation_id}`. |
| `delegation-revoke` | `delegation-revoke` | `revoke` | `{delegation_id}` |
| `delegation-activate` | `delegation` | `reject, expire, cancel` | Legacy; units-api has no handlers. Effectively dead. |
| `profile-update` | `profileUpdate` | `initiate, verify_current_ownership, verify_new_email, verify_new_mobile, execute_update` | `config.otpTimeoutMs 600000` |
| `scope-approval` | `scope-approval` (row only; no Restate service) | `reviewed` (superadmin approve/reject per scope), `cancel` (requester withdraws) | Seeded by `11-scope-approval-workflows.sql`. Both actions are in-API handlers doing synchronous registry writes. |

### 2.2 `workflows` and `workflow_ops` (DDL in units-api `V06__workflows.sql`, `V08__workflow_ops.sql`; Prisma in units-workflows is a typed view and **never** runs `prisma migrate deploy`)

```sql
workflows(txn_id varchar(255) pk,            -- = Restate workflow id
  workflow_name, status default 'pending', payload jsonb, identities jsonb default '[]',
  caller_instance, initiator_account, outcome jsonb, retry_attempts int default 0, last_error text, created_at, updated_at)
workflow_ops(txn_id, op_seq, op_type varchar(64), details jsonb, result jsonb, created_at, primary key(txn_id, op_seq))
```

Status vocabulary:
- Legacy: `pending | pending_verification | pending_update | completed | failed | rejected | timed_out | expired | cancelled`.
- Federation: `SUBMITTED → PREPARED → COMMITTING → COMMITTED`, off-path `ABORTED | AUTO_REVERSING | REVERSED | STUCK`. `proxy_record` adds `PROXY_RECORDED | SOURCE_DEBITED | DESTINATION_RECORDED`.

### 2.3 Adding a new workflow (checklist)

1. **App**: `units-workflows/apps/<name>/` with `package.json` (exports `./workflow` and `./register`), `tsconfig.json`, `src/{workflow,register,config,app}.ts`.
2. **workflow.ts**: `restate.workflow({ name: "<restateService>", handlers: { run, <signal handlers>, getStatus } })`.
   - `run` gets a `WorkflowContext` (exclusive, once per id).
   - Signal and query handlers get a `WorkflowSharedContext`. Signals resolve or reject durable promises (`ctx.promise(name)`), and queries read `ctx.get`.
   - Wrap side effects in `ctx.run("<stable-name>", ...)` so they're journaled. Keep names stable across deploys, because renaming breaks replay of in-flight workflows.
   - Use `awaitPromiseWithTimeout(ctx, name, ms)` for human waits. Use `TerminalError` for non-retryable failures.
   - Persist status with `@units/workflow-db` `WorkflowRepository`.
3. **Validation**: a Zod schema for the input, with `TerminalError` on failure.
4. **register.ts**: `postWithEnvelope(\`${WORKFLOW_API_URL}/v1/internal/workflows/register\`, {id:"api.internal.workflow.register", version:"1.0", developerToken: DEVELOPER_TOKEN, authorization:""}, WORKFLOW_DEFINITION)`. The definition is `{workflowName, version, description, config, steps:[{name,description}], jsonSchema, restateService}`. `jsonSchema` must validate `{action, data}` for every step. Registration retries 5 × 3 s, and exhaustion only warns, so a workflow can run while invisible to units-api. Check the `workflow_registry` row.
5. **Gateway**: add to `workflows` and `registrations` in `apps/gateway/src/app.ts`, and add the `@units/<name>` dependency.
6. **Restate**: the deployment must be (re)registered (`POST {admin:9070}/deployments {uri}`) so Restate discovers the new service. The gateway does this when `RESTATE_ADMIN_URL` is set.
7. **units-api, if the workflow needs domain logic or a typed trigger**:
   - Add an action handler in `src/handlers/` and register it in `handlers/registry.go`.
   - Make sure the **scope catalogue** maps whatever api ids you add. The catalogue lives in units-services `registry/specs/db/seed/R__scope_catalogue.sql`. Missing rows fail closed with `500 SCOPE_MAPPING_NOT_CONFIGURED`.
   - Optionally add a seed row under `scripts/seed/NN-*.sql`.
8. **Tests**: Jest in the app. Run `make test` / `npx turbo run test --filter=@units/<name>`.
9. **CHANGELOG** entries in units-workflows (and units-api if touched).

---

## 3. `primitive-operation` workflow: the generic federation saga engine

Every token write (mint, add/import, transact, transfer) becomes a **PrimitivePlan** executed by this workflow. Restate service `primitive-operation`, handlers `run`, `primitiveCompleted`, `getStatus`. **Workflow id = `plan.txnId`** (UUIDv7, also the `transactions.id`).

Config:
- `PORT=9084`
- `ULIP_BASE_URL` (the local units-api ULIP base)
- `LOCAL_INSTANCE_ID` (UUID, required; replaced `LOCAL_INSTANCE_NAMESPACE`, which was breaking)
- `DATABASE_URL`, `DEVELOPER_TOKEN`, `WORKFLOW_API_URL`
- `ULIP_SIGNING_PRIVATE_KEY` (+ `ULIP_SIGNING_KEY_ID`, default `ed25519-key-1`). **Always set it**: peers expect signed envelopes.

### 3.1 Who starts it

`units-api` `FederationService`:
- `StartDomainLifecycle` handles mint, add, import and every non-transfer op.
- `StartTransfer` handles transfers.

Both build a plan with the operation planner (`src/services/operation_planner*.go`), insert `transactions` (`status:"pending"`, `status_v2:"submitted"`, `plan_data`), then `StartWorkflow("primitive-operation", txnId, {plan})`.

Template resolution: first the program's own `plan()` (published in `token_programs.config.plans` → capability document), otherwise the **built-in recipes** compiled into units-api (`services/operation_planner_recipes.go`; the old `primitive_templates` table is gone).

| Recipe | Version | Used for | Steps |
|---|---|---|---|
| `two_party_prepare_commit` | 2.0 | FT/NFT/voucher transfer (cross- or same-instance FT) | 1 `Lock`@source → 2 `CreateIncoming`@destination (proofRefs proofOfLock:1) → 3 `CommitDebit`@source (prunes 1, retryPolicy) → 4 `CommitCredit`@destination (proofRefs commitProof:3, prunes 2, retryPolicy). **pointOfNoReturnOpSeq = 3** |
| `proxy_record` | 2.0 | PROXY-FT (stablecoin mirrors) | 1 `RecordProxyEntry`@source → 2 `Debit`@source (prunes 1) → 3 `RecordProxyEntry`@destination (proofRefs sourceProxyRecord:1) → 4 `Credit`@destination (prunes 3). **No compensationPolicy.** |
| `domain_lifecycle` | 2.0 | Everything else (mint, add, import, loan/pool ops, credential revoke, burn/freeze/...) | single `DomainLifecycle`@source → COMMITTED |

### 3.2 Plan shape (`{workflowId?, plan}`, zod `primitiveOperationRequestSchema`)

| Field | Meaning |
|---|---|
| `txnId`, `operationName`, `templateName`, `templateVersion` | identity of the plan |
| `routeSnapshot` | `{resolvedAt, callerInstance, sourceInstance, destinationInstance, sourceEndpoint?, destinationEndpoint?, recipientAddress}`. Instances are UUIDs. |
| `participants` | `Record<role, {role, accountDid, name?, address?, instance, endpoint?}>`. **`name` must be preserved**, because it's in the plan hash (else `primitive_plan_intent_hash_mismatch`). |
| `assetSelector` | `tokenClassId, value, tokenKind, category, operation, tokenId, destinationTokenId, chainId, contractAddress, source/destinationWalletAddress, txHash, signedProxyTx, metadata, data, identities, relationships, additionalStateRequirements, proxyProof, extensions` |
| `steps[]` | `{opSeq>0, method, calleeRole, dependsOn[], inputRefs{name→opSeq}, proofRefs{name→opSeq}, prunesOpSeq?[] (must stay ABSENT, not [], for hash parity), timeoutMs?, retryPolicy?{maxAttempts, initialBackoffMs, maxBackoffMs, maxDurationMs}, payload{}}` |
| `compensationPolicy?` | `{pointOfNoReturnOpSeq, prepareFailure: CompStep[], commitFailure?: {queryDestinationStatus?: {recipientRole, opSeqRef?}, notCommittedSteps: CompStep[], unknownStatus (default "STUCK")}}`. CompStep = `{opSeq, method, calleeRole, ifCompleted?, payload}` |
| `statusPolicy` | `{initial:"SUBMITTED", afterStep:{"<opSeq>": status}, onAbort:"ABORTED", onStuck:"STUCK"}` |

Op-seq numbering: plan steps 1..N, prepare-failure compensations 100+N, commit-failure compensations 200+N, prune calls 900+prunedOpSeq. **`(txn_id, op_seq)` is the idempotency key at the callee.**

Two-party compensation (from the recipe):
- `prepareFailure`:
  - `RejectIncoming`@destination (102, ifCompleted 2, `{senderTxnId:"$.txnId", senderOpSeq:1, reason:"prepare_failed"}`)
  - then `Unlock`@source (101, ifCompleted 1).
- `commitFailure`:
  - `queryDestinationStatus {recipientRole:"destination", opSeqRef:4}`
  - `notCommittedSteps`: `Credit`@source (201, `{reversesTxn:"$.txnId", reason:"destination_not_committed"}`), then `RejectIncoming`@destination (202).
- `statusPolicy.afterStep`: `{2:PREPARED, 3:COMMITTING, 4:COMMITTED}`.

Value refs in step payloads: `"$.path"` resolves against the plan, and `{"$proof": N}` gives the envelope bytes of opSeq N. An unresolvable ref → TerminalError (fail-loud).

### 3.3 `run` sequence (`runPrimitiveOperation`)

1. Zod-validate → `TerminalError("Invalid primitive operation request: ...")`.
2. `ctx.run("create-workflow-record")` → `workflows` row (`workflow_name = plan.operationName`, `initiator_account = participants.source.accountDid`, status = `statusPolicy.initial`).
3. For each step, sorted by `opSeq`:
   1. Every `dependsOn` must have an output.
   2. `executePrimitive`:
      - `buildStepPayload`.
      - `ctx.run("step-<method>-<opSeq>-attempt-<n>")` → signed ULIP POST to `{endpoint}/v1/ulip/<Method>` + `POST /v1/internal/workflow-ops/record`.
      - With `retryPolicy`, it's wrapped in `commitWithRetry`: journaled sleeps, exponential backoff, a budget (policy defaults 48 h, 1 m initial, 1 h max, 15 attempts), and `RetryExhaustedError` on exhaustion.
      - A non-retry `TerminalError` from the send becomes `PrimitiveSendRejectedError` (4xx before dispatch; the callee created no row).
   3. Await the durable promise `primitive:<txnId>:<opSeq>` with `step.timeoutMs ?? 30000`. The `primitiveCompleted` handler resolves it. The completion method must equal the step method (normalised). `status:"FAILED"` → `PrimitiveExecutionError`.
   4. `prunePreparedRows`: for each `prunesOpSeq`, ULIP `PruneTokenTransactions` at opSeq 900+n (3 bounded retries). It **never throws** and is never run on compensation paths. It runs *before* the status persist because proofService batches only `completed` txs.
   5. `statusPolicy.afterStep[opSeq]` → `persistStatus`: Restate state + `workflows.status` + `POST /v1/internal/transactions/lifecycle-update {txn_id, status_v2, last_error, retry_attempts?}` (best effort).
4. On step error:
   - **Before the point of no return** (or at PONR with Execution/SendRejected): run `prepareFailure` compensations (skipped when the `ifCompleted` step has no output) → **ABORTED**.
   - **After PONR, send rejected**: AUTO_REVERSING → `notCommittedSteps` → **REVERSED** (STUCK if there are no steps).
   - **After PONR, timeout / execution failure / retry exhaustion** (the destination *may* have committed): AUTO_REVERSING → `POST /v1/internal/transactions/destination-status {txn_id, recipient_did, recipient_home, op_seq}`.
     - `COMMITTED` → COMMITTED.
     - `NOT_COMMITTED` → notCommittedSteps → REVERSED.
     - `UNKNOWN` (or any error) → `unknownStatus || onStuck` → **STUCK** (manual ops; there's no automated recovery).
5. All OK → COMMITTED. Result `{txnId, status: COMMITTED|ABORTED|REVERSED|STUCK}`.

`getStatus` returns `{status}` from the `workflows` row, falling back to Restate state.

### 3.4 `buildStepPayload` (what each callee primitive receives)

- **Flat fields**, only when set: `accountDid` (callee participant), `tokenClassId`, `value`, `tokenKind`, `category`, `operation`, chain fields, `metadata`, `data`, `identities`, `relationships`, `additionalStateRequirements`, `proxyProof`.
- **Role-specific**: `tokenId` (destination uses `destinationTokenId`), `sourceTokenId`, `walletAddress`, `completionTarget = routeSnapshot.sourceEndpoint`, `timeoutSecs = ceil(timeoutMs/1000)`, `sourceInstance`.
- **Refs**: `inputRefs` → opSeq numbers. `proofRefs` → base64 envelope bytes. Also `commitProofOpSeq`, `senderOpSeq`, `senderTxnId`, `direction`.
- **Namespaced**: `asset` (full assetSelector), `primitive {txnId, opSeq, method, calleeRole, templateName, templateVersion, operationName}`, `participants`, `snapshot {route, capability, authorization, planIntent}`, `proofs`, `extensions`. Step `payload` extras are merged, and reserved keys are stripped with a warning.
- `planIntent.planHash` = sha256 of the stable-key-sorted plan JSON with Go-`omitempty` fields dropped when empty. The destination gateway recomputes it. Any TS/Go divergence → `primitive_plan_intent_hash_mismatch`.

Endpoint routing: a participant on `LOCAL_INSTANCE_ID` → `ULIP_BASE_URL`. Otherwise it uses `participant.endpoint || routeSnapshot.destinationEndpoint`.

### 3.5 ULIP call mechanics (`@units/workflow-utils` `executeUlipCall`)

```json
{ "context": { "txn_id":"...", "op_seq":1, "caller_instance":"<uuid>", "callee_instance":"<uuid>",
               "method":"Lock", "ulip_version":"v1", "sent_at":"<ISO>" },
  "payload": { ... },
  "signature": { "signer_instance":"<LOCAL_INSTANCE_ID>", "key_id":"ed25519-key-1",
                 "algorithm":"ed25519", "signature":"<base64>" } }
```

- **Signing input** = `JCS(canonical_context) ‖ JCS(payload)` (RFC 8785, npm `canonicalize`). It must byte-match Go `envelope.CanonicalSigningInputFields`, and golden-corpus tests guard this.
- **URL**: `{endpoint}/v1/ulip/<Method>` (peer units-api). Registry calls use `/ulip/v1/...`.
- **Errors**:
  - 4xx → TerminalError.
  - 5xx, network or non-JSON 2xx → retryable.
  - App-level `errorCode` ∈ {NAME_TAKEN, PEER_DENIED, TOKEN_CLASS_REJECTED, UNAUTHENTICATED, ACCOUNT_NOT_FOUND} → TerminalError.
- **Returns** `{envelopeBytes, response, sentAt, receivedAt, responseStatus, responseBodyBytes}`. The callee dedups on `(callerInstance, txnId, opSeq)`.

### 3.6 `primitiveCompleted` handler (signal) and completion callbacks

```
token engine ──POST signed JSON──► source units-api POST /v1/internal/primitives/complete
     (auth = payload signature, not dev token)        │ record completion on primitive_ops,
                                                      │ arm signal outbox (signal_name=primitiveCompleted)
                                                      ▼ FlushSignal (best effort) + poller
                     Restate SignalWorkflow("primitive-operation", txnId, "primitiveCompleted", payload)
                                                      ▼
                     resolves durable promise primitive:<txnId>:<opSeq>  (idempotent: peek() first)
```

Engine callback body (snake_case):

```json
{ "txn_id":"T1","op_seq":1,"method":"lock","status":"COMPLETED",
  "caller_instance":"<uuid>","callee_instance":"<uuid>","workflow_id":"T1",
  "token_ids":["0196..."], "response":{"status":"completed","txId":"T1","opSeq":1,"operation":"lock","tokenIds":["0196..."]},
  "error_code":null,"error_message":null,
  "signature":{"signer_instance":"<LOCAL_INSTANCE_ID>","key_id":"ed25519-key-1","algorithm":"ed25519","signature":"<b64>"} }
```

- **Signing input** = newline-joined `[txn_id, op_seq, method, STATUS, caller_instance, callee_instance, workflow_id, token_ids.join(","), error_code, error_message, hex(sha256(json(response)))]`.
- **units-api verifies** (`verifyPrimitiveCompletionSignature`): `signer_instance == callee_instance`, and the key is resolved from the registry's instance keys. **Signatures are required.**
- **Engine signer** comes from `PRIMITIVE_COMPLETION_SIGNING_KEY` (or `ULIP_SIGNING_PRIVATE_KEY`) and `PRIMITIVE_COMPLETION_SIGNING_INSTANCE` (or `LOCAL_INSTANCE_ID`). If either is missing, the engine sends **unsigned** callbacks (metric `completion_signer_disabled`), and units-api rejects them with `401 primitive_completion_signature_required`.
- **Engine outbox**: polls every 5 s, claims ≤50 rows (`FOR UPDATE SKIP LOCKED`, 30 s lease), backs off `min(2^attempts, 60)` s.
- **units-api backfills** created token ids for Mint/DomainLifecycle from `token_ids`.

---

## 4. `primitive_ops`: outbox and idempotency (units-api `specs/db/V09__primitive_ops.sql`)

PK `(txn_id, op_seq)`. Each column group has exactly **one writer**, and writes are targeted UPDATEs only.

| Group | Columns | Writer | Purpose |
|---|---|---|---|
| base | `txn_id, op_seq, method, callee_instance, caller_instance, status ('recorded'), details, result, created_at, updated_at` | ULIP gateway (units-api) | row admitted on the callee |
| (A) admit / dedup | `request_hash, admit_status, admit_response, admit_error` | gateway | replays of the same `(txn_id, op_seq)` return the cached admit response; a different request hash is a conflict |
| (B) command outbox | `command_status, command_kafka_key, command_payload, command_attempts, command_next_at, command_error, command_sent_at` | `PrimitiveOutbox` (units-api) | Kafka publish to `units.token.operations` (5 s tick, 30 s lease, batch 50, retries forever with backoff, `outbox_delivery_stuck` WARN after 10 attempts, **never dead-letters**) |
| (C) engine result | `engine_status ('executed'\|'failed'), engine_result, engine_executed_at` | token engine | written **in the same sql tx as the token mutation** with CAS `engine_status IS NULL`. The engine's idempotency read checks this first and replays the cached completion. |
| (D) completion outbox | `completion_status ('pending'\|'sent'\|'failed'), completion_target, completion_payload, completion_attempts, completion_next_at, completion_error, completion_sent_at` | token engine | signed callback delivery |
| (E) signal outbox | `signal_status, signal_name, signal_workflow, signal_workflow_id, signal_payload, signal_attempts, signal_next_at, signal_error, signal_sent_at` | units-api (source) | completion → Restate signal |

Consequences:
- **Exactly-once execution per `(txn_id, op_seq)`** at the engine. A duplicate Kafka delivery hits the idempotency read, and a concurrent duplicate rolls back on the CAS. If no `primitive_ops` row exists (hand-crafted Kafka message), the CAS update affects 0 rows → `RowNotFound` → retry → DLQ.
- **No request-level idempotency at the API.** `msgId` is logging only, and `correlation_id` is non-unique. Two identical `/v1/token/mint` POSTs create two txns. Integrators must dedupe on their own business ids.
- Retryable engine errors (DB, Kafka, concurrency) write **no** terminal record, so the saga can go STUCK rather than produce a spurious FAILED.

---

## 5. Kafka (internal only)

| Topic | Partitions (local compose) | Producer → consumer | Key |
|---|---|---|---|
| `units.token.operations` | 4 | units-api `PrimitiveOutbox` → token engine; also engine secondary ops | `txId` (so there's **no per-token ordering**; correctness relies on optimistic locking) |
| `units.token.operations.dlq` | 1 | engine after final failure | `"{partition}:{offset}"` |
| `units.token.events` | 4 | engine audit (`auditEnabled`, default **false**) | `event_id` |

The engine consumes **sequentially, one message at a time per pod**, with manual offset commit after success *and* after DLQ. `TokenOperationMessage` (camelCase) has these required fields: `txId, operation, tokenClass, payload, correlationId, timestamp, identities`. Optional: `tokenId, traceContext, signature, opSeq, callerInstance, calleeInstance, workflowId, completionTarget, assetSelector, requestEnvelope`. There's **no** top-level `initiator`. Full schema and examples are in `authoring-token-programs.md` §6 and in the token-runtime notes.

DLQ body (snake_case): `{original_payload, error, error_code, retry_count, failed_at, original_partition, original_offset, context:{tx_id, correlation_id, token_class, operation}}`. Bug: `context` reads snake_case keys from a camelCase message, so everything except `operation` is null. Many variants map to `UNKNOWN_ERROR`. Read `original_payload.txId`.

Naming inconsistency: some configs mention `units.token.operations.audit`, while the engine and compose use `units.token.events`.

---

## 6. Delegation workflows (`delegation`, `delegation-revoke`)

Front door: `POST /v1/workflows/execute {workflow:"delegation-create", action:"allow"|"deny"|"approve"|"reject"|"cancel", data}` and `{workflow:"delegation-revoke", action:"revoke", data:{delegation_id}}`. List with `/v1/delegations/list {filter: granted_by_me|granted_to_me|pending}`. Check with `/v1/delegations/check {tokenId}`.

units-api handlers (`handlers/delegation.go`):
- `allow`/`deny` create a **pending** delegation in the **registry** (the only source of truth; there's no local delegations table), then `StartWorkflow("delegation", ...)`.
- `approve`/`reject`/`cancel` are now **synchronous registry writes** (`ApproveDelegationFederated` + local reconcile, `RejectDelegation`). They no longer rely on signalling the Restate promise.
- `revoke` → `StartWorkflow("delegation-revoke", ...)`.

`DelegationRequest`:

```json
{ "workflowId":"delegation-create-<uuid>", "delegationId":"<uuid>", "grantorAddress":"<hash>", "granteeAddress":"<hash>",
  "label":"tokens:tokenclass:USDC", "permission":"transact", "ruleType":"allow", "expiresAt":null,
  "isOwner":false, "userJWT":"Bearer ...", "allowedOperations":{"tokens:transact":{"payload.value":["10","20"]}} }
```

Labels: `<entity>:id:<uuid>`, `<entity>:*`, `<entity>:<field>:<value>`, `<entity>:<jsonb>.<key>:<value>`. Entities: `tokens, tokenClasses, tokenClassConfigs, registry-chains, registry-wallets, registry-adapters, registry-programs, clients, keys`. Path segments must match `^[a-zA-Z0-9_]+$`.

`delegation.run`:
1. Validate.
2. Create the workflows row (`pending`).
3. `validate-label`. A bad label → ULIP `DelegationReject` → `rejected`.
4. `resolve-grantee-name`.
5. **Owner path**: `activate-and-reconcile` → `completed`, `status:"active"`.
6. **Non-owner path**: `pending_approval` → await promise `owner-approval` (timeout `APPROVAL_TIMEOUT_MS` = 7 d).
   - Approve → activate + reconcile.
   - Cancel → `cancelled`. Reject → `rejected`. Timeout → `expired`. Each of these sends `DelegationReject`.

`activateAndReconcile`:
1. ULIP `DelegationApprove` to the registry (`/ulip/v1/delegation/approve`, callee `REGISTRAR_NAMESPACE`, opSeq 0).
2. Fan out `POST {peer}/v1/internal/delegation/reconcile {granteeAddress, granteeName, label, grantorAddress}` to **every** entry in `RECONCILE_PEER_URLS` (JSON map instanceUUID → units-api URL; it must include the local instance). Each instance restamps matching tokens' `identities[]` with `{id, name, type:"access"}` (owner entries are never touched; `access` is excluded from the commitment hash).
3. Any peer failure → retry (fail-closed; both steps are idempotent).

**An empty `RECONCILE_PEER_URLS` disables fan-out entirely**, so grants never stamp tokens.

`delegation-revoke.run` follows the same pattern with `DelegationRevoke` (`/ulip/v1/delegation/revoke`) + fan-out → `status:"revoked"`.

---

## 7. profile-update workflow (`profileUpdate`)

1. `/v1/workflows/execute {workflow:"profile-update", action:"initiate", data:{name?|email?|mobile?}}` (user JWT).
   - units-api `makeInitiateHandler` loads the account and decrypts the current email/mobile via Vault (user JWT).
   - It builds `verificationSteps`: always `verify-current-ownership`, plus `verify-new-email` / `verify-new-mobile`.
   - It starts the workflow and returns 202 `{workflowId:"profile-update-<uuid>"}`.
2. `run` sends each OTP through `ctx.run("send-otp-<step>")` → notificationService `POST /api/v1/otp/generate {channel, recipient}`. It then awaits a promise per step (`OTP_TIMEOUT_MS` 10 min).
3. The client sends `action:"verify_current_ownership"|"verify_new_email"|"verify_new_mobile"` with `{workflowId, otp, recipient}`. units-api verifies the OTP with the OTP service, then `SignalWorkflow("profileUpdate", id, "verify", {step, otp, recipient})`.
4. After all steps: `pending_update` → `ctx.run("execute-account-update")` → POST back to units-api `/v1/workflows/execute {action:"execute_update"}` with the stored user JWT → `AccountService.Update` (PII re-encrypted, registry `UpdateAccount`).
5. Ends `completed`. Other outcomes: `cancelled` (cancel handler), `timed_out`, or `failed`.

Caveat: the user JWT stored in input may expire during the wait.

## 8. Scope approval (in-API, no workflow)

A client's pending scope request is decided with `/v1/workflows/execute {workflow:"scope-approval", action:"reviewed"|"cancel", data}` (list pending with `/v1/scope-approvals/*`). This is handled in units-api as a **synchronous** registry write: `/ulip/v1/scope/approve|reject`, act-only-if-pending, which records `approved_by/at`. The registry's `ScopeExpirySweeper` expires pending scopes after 7 days (`REGISTRY_SCOPE_EXPIRY_SWEEP_SECONDS`=300). Superadmins see all pending approvals (`ClientListByScopeStatus`).

## 9. units-workflows known gaps

- CLAUDE.md is stale. `register-restate.sh` registers the removed scope-approval app. `delegation-activate` is still registered.
- Registration failure is mostly non-fatal: a workflow can serve while invisible to units-api. Check `workflow_registry`.
- `recordOp` silently no-ops if the Prisma client isn't regenerated.
- STUCK after the PONR requires manual resolution. There's no tooling.
- The user JWT is replayed across long waits (profile-update), which blocks shorter access-token lifetimes.
- The Restate outbox in units-api never dead-letters. Stuck rows are retried about once a minute with an `outbox_delivery_stuck` WARN.

---

# units-services

Five independent services plus shared CI. Each service ships its own container image. CI is PR-only. See `local-development.md` for build and test commands.

## 10. registry (Go): central federation registry ("registrar")

The central Postgres directory for the federation. It signs records with the registrar Ed25519 key (`REGISTRAR_KEY_ID` `registrar-key-1`), and clients pin the trust anchor as `REGISTRAR_PUBKEY`. Spec: `docs/specs/units-federation/04b-central-registry-v1.md` (Spec 04b), Spec 01 (ULIP), Spec 09, ADR-005/006/008/009.

### 10.1 What it holds (and doesn't)

| Holds | Table(s) |
|---|---|
| Accounts / names: address hash → DID → home instance, display name, contact hashes, user pubkey; signed `NameRecord` | `accounts` (PK `address` = sha256 hash; renamed from `registered_names`) |
| Instances + self-signed capability documents | `registered_instances (id uuid, name, api_url, ulip_url, well_known_url, capability jsonb, signed_by = id)` |
| Instance public keys (trust store for ULIP) | `public_key_registry (instance_id, key_id, algorithm ed25519, public_key, status pending\|active\|superseded\|revoked, is_primary)` |
| Developer credentials (registry-authoritative) | `developer_clients`, `developer_keys` (hash only), `scopes`, `scope_apis`, `rate_limit_tiers`, `rate_limit_rules` |
| Delegations | `delegations (grantor_address, grantee_address, grantee_address_type account\|oidc-client, label, permission, rule_type, status active\|pending\|rejected\|revoked\|expired\|cancelled, expires_at, allowed_operations, ...)`, unique among live rows, no self-delegation |
| OIDC clients ("Login with Finternet" RPs) | `oidc_clients (client_id, redirect_uris, keycloak_client_id, grantee_address, scope_restrictions [{label, permission, allowed_operations?}], ...)` |
| Replay log / audit | `request_log (caller_instance_id, txn_id) PK, TTL 7 d`; `audit_log` |

It does **not** register chains, adapters, token classes or programs. Those are per-instance units-api tables. Capability docs only *advertise* `chains_supported` and `token_classes_accepted/issued`.

DDL: `units-services/registry/specs/db/V01..V13` + `seed/R__scope_catalogue.sql`, `R__rate_limit_defaults.sql`. **There's no Flyway or auto-migration in the registry binary.** Schema is applied by psql (`make db-migrate` with `$DB_URL`, compose initdb, or the deployment's Flyway job).

### 10.2 Signed records

- **NameRecord**: registrar Ed25519 over the JCS of the body minus `signature`, `key_id`.
  ```json
  { "address":"alice@a.local","did":"did:units:0x<64hex>","home":"<instance uuid>",
    "home_endpoints":{"api_url":"...","ulip_url":"..."},"name":"Alice","user_public_key":"<b64>",
    "email_hash":"<hex>","phone_hash":"<hex>","version":1,"as_of":"2026-07-01T10:00:00.000Z",
    "signed_by":"registrar.finternet.lab","key_id":"registrar-key-1","signature":"<b64>" }
  ```
  - Empty fields are omitted, so legacy records stay byte-identical.
  - `as_of` is pinned to JS `toISOString()` format.
  - Verifiers: Go registry signer, units-api `rest_resolver.go::verifyNameRecord`, workflows `RegistryClient`.
  - `HashAddress(x) = HashContact(x) = hex(sha256(lower(trim(x))))`. DID = `did:units:0x<hex ed25519 pubkey>`.
- **Credential bundle** (credential resolve, on every units-api request with short caching): `{client_id, owner_addresses[], scopes[], allowed_operations{}, is_super_admin, rate_limit_tier_id, key_expires_at, as_of, not_after (as_of+10 s), signed_by, key_id, signature}`.
- **Capability document**: self-signed by the instance. The `UpsertCapability` self-bind rule is envelope signer == `:id` == `capability.instance` == `capability.signed_by`. The first publish may be TOFU when `REGISTRY_ALLOW_TOFU_BOOTSTRAP`.

### 10.3 Endpoints

Public routes:

| Route | Auth | Purpose |
|---|---|---|
| `GET /health`, `/ready` | none | liveness / DB readiness |
| `GET /v1/.well-known/registrar-pubkey` | none | `{current, key_id, valid_from, valid_until?, previous[]}` |
| `GET /.well-known/jwks.json` | none | RFC 7517 JWKS (OKP Ed25519, kid `registrar-key-1`) |
| `GET /.well-known/ulip.json` | none | legacy shape (+ OTP issuer keys) |
| `POST /v1/account/login` | none (the OTP is the gate) | `{payload:{username, otp?}}`. Without `otp` it proxies OTP generate. With `otp` it verifies and returns an existing account `{is_existing:true, home_instance, did, access_token}` or a new one `{is_existing:false, instances:[...], access_token}`. |
| `POST /v1/account/create` | OTP-JWT | name reservation → `201 {reservation_proof, expires_at, challenge_id:"otp-<hash>"}`; 409 NAME_TAKEN/NAME_RESERVED |
| `POST /ulip/v1/info` | none | supported methods |
| `POST /ulip/v1/name/register|resolve`, `/accounts/get|update`, `/capabilities` | peer envelope | names and capabilities |
| `POST /ulip/v1/credential/resolve`, `/scope/catalog`, `/ratelimit/catalog`, `/delegation/fetch`, `/client/list|get`, `/key/list`, `/delegation/list|get` | hardened envelope | signed reads (opaque 404 for unknown credentials) |
| `POST /ulip/v1/client/register|update|deactivate|secret/rotate|reactivate|scopes/update`, `/key/create|revoke`, `/scope/request`, `/delegation/create` | hardened + **owner-signed inner envelope** + request_log dedup + audit | creation mutations (units-api signs the owner envelope with the account's Vault Transit key) |
| `POST /ulip/v1/delegation/request` | hardened, instance-authorised | non-owner pending delegation |
| `POST /ulip/v1/scope/approve|reject`, `/delegation/approve|reject|revoke` | hardened, instance-authorised, act-only-if-pending | approvals (also used by the delegation workflow) |
| `GET /v1/names/:name`, `GET /v1/accounts/:did` | internal service credential | REST mirror of signed NameRecords (used by the workflows `RegistryClient`) |
| `POST /v1/resolve` | internal service credential + per-contact rate limit (0.1 rps, burst 5) | `{email}|{phone}` → `{did, home, home_endpoints, home_instance_name}` or a bodyless 404 |
| `GET /v1/instances`, `/v1/instances/:id`, `/v1/instances/:id/public-key` | internal service credential | directory |
| `POST /v1/oidc/clients`, `GET /v1/oidc/clients/:clientId` | internal service credential | onboard a third-party OIDC client (creates the KC client in realm `finternet` with the `delegated browser` flow) |
| `POST /v1/oidc/consent` | internal service credential | the BFF materialises the client's `scope_restrictions` into per-user delegations (grantee type `oidc-client`) |

Capability publishing (self-bind enforced; `403 CAPABILITY_SELF_BIND_VIOLATION`) and dual-signed name migration go through a separate authenticated internal interface.

"Hardened" means: `ExpectedCallee = REGISTRAR_NAMESPACE` (audience), `MaxClockSkew` 120 s, signer key from `public_key_registry` (optionally widened, never revoked, by the signer's `{well_known_url}/.well-known/jwks.json`, with an SSRF guard), `caller_instance == signer_instance`, and replay protection via `request_log`. Errors: MALFORMED 400, UNAUTHENTICATED 401, PEER_DENIED 403.

Background goroutines: RequestLogSweeper, ScopeExpirySweeper (7-day pending SLA), a Keycloak reconciler that keeps SA clients `sa-<uuid>` in sync with the registry, DB pool gauge.

### 10.4 Developer credentials

- `clientId = "sa-" + <uuid>` and `clientSecret = base64url(32 random bytes)`.
- **developerToken** = `base64std(clientId + ":" + clientSecret)`. `key_hash = hex(sha256(clientId:secret))` (`kind sa_secret`). Legacy API keys are `fnt_...`.
- Superadmin = scopes `["*"]` / `is_super_admin`. It bypasses `CheckServiceAccountScope` **and** the client `allowed_operations` narrowing. Only a superadmin can mint another.
- Scope catalogue: `scopes(entity:verb, access_level public|protected)` + `scope_apis(scope_key → api_id per catalog_version)`. Every units-api `api.*` id needs a row, or it fails closed with `500 SCOPE_MAPPING_NOT_CONFIGURED`. **When you add an endpoint in units-api, add the catalogue row in `units-services/registry/specs/db/seed/R__scope_catalogue.sql`.**
- Rate tiers: `standard` (`*:read` 1000/60 s, `*:transact` 100, `*:manage` 50, `*` 500), `internal` (10×). Per-IP limiting (`REGISTRY_RATE_LIMIT_RPS` 100/burst 200) is in-memory per replica.

### 10.5 Key config

`APP_CONFIG`, `DB_PROVIDER=postgres`, `DB_CONFIG`, `REGISTRAR_NAMESPACE` (e.g. `registrar.finternet.lab`), `REGISTRAR_SIGNING_KEY_FILE`, `REGISTRAR_KEY_ID`, `REGISTRY_ALLOW_TOFU_BOOTSTRAP`, `REQUEST_LOG_TTL_DAYS=7`, `REGISTRY_CREDENTIAL_BUNDLE_VALIDITY_SECONDS=10`, `REGISTRY_ENVELOPE_MAX_SKEW_SECONDS=120`, `REGISTRY_SA_SECRET_GRACE_MAX_SECONDS` (7 d), `OTP_SERVICE_URL`, `REGISTRY_OTP_JWT_PUBLIC_KEY|ISSUER|KEY_ID` (or discovered from the OTP well-known), OTel. Keycloak and internal-interface settings are deployment-specific.

**Operational coupling**: units-api resolves developer tokens through the registry on each request (short cache). A registry outage means **503 on every authenticated call** (fail closed).

### 10.6 Registry gaps

- README "Phase 1 scaffold" is stale.
- `units-ulip-go` SDK not wired (local `src/envelope` copies). Legacy wallet envelope dual-accept.
- Rate limiter is per replica. Registrar key rotation is planned. DNS publishers are TODO.
- No auto-migration.

---

## 11. proofService (Rust): Merkle batch proofs

A background **write-only batch generator**. The public read and verify API is on **units-api** (`POST /v1/transaction/proof`, `/proof/leaf`, `/proof/verify`, in `services/proof.go`). proofService itself only exposes `GET /v1/health` on `API_PORT`.

Stack: tokio, axum 0.7, sqlx 0.8, rs_merkle 1.4 + blake3. Config (`__` separator): `DATABASE_URL`, `MERKLE_BATCH_SIZE` (100/1000), `MERKLE_POLL_INTERVAL_SECS` (30/60), `API_PORT` (8081), `HEALTH_PORT` (unused), `RUST_LOG`, `RUN_MODE`.

Algorithm (`ProofGenerator.process_batch`, every poll, all in **one DB tx**):
1. `SELECT ... FROM transactions WHERE proof_id IS NULL AND status='completed' ORDER BY created_at LIMIT $batch FOR UPDATE`. **If there are fewer than `MERKLE_BATCH_SIZE` rows, it does nothing.** There's no time-based flush, so low traffic means proofs stay `pending` indefinitely.
2. Lock the children: `token_transactions WHERE tx_id = ANY(ids) ... FOR UPDATE`. Only value-moving ops are included (`commit_credit, commit_debit, credit, debit` by default). Prepare rows (`lock`, `create_incoming`, `record_proxy_entry`) live in `primitive_ops` and get pruned.
3. `TransactionLeaf` per tx (all columns except proof_id/proof_profile/batch_id, children sorted by id). **Leaf hash = BLAKE3(compact JSON, keys sorted, RFC3339 timestamps normalised to 6-digit microseconds `...ffffffZ`).**
4. Merkle tree (internal node = BLAKE3(left‖right)), root as hex.
5. Insert a `proofs` row `{proof_profile:"merkle-tree", proof_data:{algorithm:"blake3", merkleRoot, leaves:[{txId, leafIndex, leafHash, proofPath:[{hash, direction}], leafData}]}, state_commitment: root, batch_id, tx_ids, ledger_anchors: null, status:"proven"}`.
6. Stamp `proof_id`/`proof_profile`/`batch_id` on the transactions and `proof_id` on the children. The row counts must match or it rolls back.

The `FOR UPDATE` locks block units-api's `PruneTokenTransactions` DELETE (`WHERE proof_id IS NULL`) on rows being hashed (race fix PR #159).

Proof row states: `transactions.proof_id NULL` = pending. `proofs.status`: `pending | proven | anchoring | anchored`.

Verify independently:
1. `POST /v1/transaction/proof/leaf {tx_id}` → `jq -S -c -j '.response' | b3sum` must equal `leafHash`.
2. Walk `proofPath`: `cur = direction=="left" ? blake3(hash‖cur) : blake3(cur‖hash)` (raw 32-byte concat) → compare with `merkleRoot`.

Or call `POST /v1/transaction/proof/verify {leaf_hash, root, proof:{leaf_index, path}}` → `{valid}`. That's **structural only**.

Gaps:
- **On-chain anchoring isn't implemented.** `CHAIN_ANCHOR_*` env and the `anchor/` module are spec-only, and `ledger_anchors` is always null. Say "hash-chained, tamper-evident", never "anchored on chain".
- The per-token state commitment chain (engine, `state_history`) is separate and always live. Merkle batching is an extra layer.

---

## 12. notificationService ("otp-service")

OTP generation and verification over SMS (Twilio Verify) or email (SendGrid template, or a mock), plus minting a signed **OTP-JWT** on successful verify. Called by the registry (`/v1/account/login` proxies to it), units-api (OTP routes, profile-update verify) and units-workflows (profile-update generate). Stack: Node ≥18, Express, Twilio, @sendgrid/mail, AJV, Winston, HyperDX OTel. Default `PORT` 3000 (deployments and compose use 4000).

| Method / path | api id | Body | Response |
|---|---|---|---|
| `GET /health` | — | — | `{status:"healthy", timestamp, uptime}` |
| `GET /.well-known/ulip.json` | — | — | `{instance: JWT_ISSUER, keys:[{key_id:"<issuer>-key-1", algorithm:"ed25519"\|"rsa", public_key, status:"active"}], as_of}` (cache 1 h). Verifiers fetch the OTP-JWT key here by `kid`. |
| `POST /api/v1/otp/generate` | `api.otp.generate` | `{recipient (E.164 or email), channel?: sms\|call\|email\|whatsapp}` (closed) | `200 {success, message:"OTP sent successfully", data:{status:"pending", to, channel}}` |
| `POST /api/v1/otp/verify` | `api.otp.verify` | `{recipient, code ^\d{6}$, challenge?, channel?}` | `200 {success, data:{status:"approved", valid:true, jwt:{token, expiresIn, tokenType:"Bearer", issuer}}}` |

- **Channel**: explicit `channel`, else `@` → email, else sms.
- **Errors** `{success:false, message, error_code, retry_after?}`: `OTP_EXPIRED` 401, `OTP_INVALID` 400, `VALIDATION_FAILED` 400, `TWILIO_RATE_LIMITED` 429, `TWILIO_INVALID_RECIPIENT` 400, `TWILIO_SERVICE_UNAVAILABLE` 503, `CONFIGURATION_ERROR` / `JWT_GENERATION_FAILED` 500, `SENDGRID_ERROR`, `INTERNAL_ERROR`. README paths (`/otp/send`) are stale.
- **OTP-JWT**: compact JWS, `alg` EdDSA (default) or RS256, `kid "<JWT_ISSUER>-key-1"`. Payload `{username, channel, authMethod:"otp", typ:"Bearer", iss, iat, exp, challenge?}`.
- **Modes / env**:
  - Twilio: `TWILIO_ENABLED`, `TWILIO_ACCOUNT_SID|AUTH_TOKEN|VERIFY_SERVICE_SID`.
  - Mock: **`MOCK_OTP_ENABLED=true` → fixed `123456`**. The mock OTP store is an in-memory Map: not shared across replicas and lost on restart.
  - Email: `EMAIL_NOTIFICATION_ENABLED` (send email even in mock mode), `OTP_EMAIL_OVERRIDE_ENABLED|ADDRESS` (route all email to one inbox; SMS in mock only with override), `SENDGRID_API_KEY|TEMPLATE_ID|FROM_EMAIL`.
  - JWT: `JWT_PRIVATE_KEY` (required PEM, Ed25519 PKCS#8 or RSA matching `JWT_ALGORITHM`), `JWT_ISSUER`, `JWT_EXPIRY_SECONDS` (3600).
- **Gaps**: in-memory mock store; README stale.

---

## 13. adapterOrchestrator (Go): chain-adapter routing proxy

A thin reverse proxy that picks the **chain adapter** for a CAIP-2 chain id. Stack: Go 1.25, Fiber, GORM, dig, zap, viper. Routes: `GET /health`, and `POST /*` catch-all.

Flow:
1. Parse `{context:{chainId}}` (400 `invalid JSON body` / `missing context.chainId`).
2. `SELECT * FROM adapter_registry WHERE chain_ids @> ARRAY[chainId] AND type='chain' AND active ORDER BY priority DESC, id ASC LIMIT 1`.
3. `POST {config.url}{originalPath}` with the original body and headers, then relay the response.

No adapter → **404** `{error:"no adapter for chain: X"}`. units-api treats that as "chain not integrated" and returns empty holdings.

Adapter registry (`units-services/specs/db/registry.sql`, mirrored in units-api `V04__registry.sql`, seed `units-api/scripts/seed/06-adapter-registry.sql`):

```sql
adapter_registry(id uuid pk, adapter_id varchar(128) unique, name, type varchar(32) default 'chain', -- future: oracle, indexer
  chain_ids text[] /* CAIP-2, GIN */, priority int /* higher wins */, active bool,
  config jsonb /* {"url": required, "apiKey", "timeoutMs"} */, created_at, updated_at)
```

Seeded: `alchemy_chain_adapter` (priority 1, `http://chain-adapter:3500` locally), covering ~20 EVM mainnets, ~10 testnets, and Solana mainnet/devnet.

**Adapter HTTP interface.** The full spec is in `units-api/specs/api/adapter-interface.yaml`: `/chain/info`, `/chain/capabilities`, `/chain/head`, `/accounts/resolve`, `/accounts/holdings`, `/balance/get`, `/assets/resolve`, `/fees/estimate`, `/transactions/build|sign|submit|status|receipt`, `/info`, `/health`. Paths actually called today (all POST, envelope `{context:{id:<correlationId>, chainId}, payload}`):

| Path | Payload | Caller |
|---|---|---|
| `/api/v1/chain-adapter/accounts/holdings` | `{chainId, accountId: walletAddress}` | units-api (holdings discovery on key registration) |
| `/api/v1/chain-adapter/balance/get` | `{chainId, address, contractAddress}` | stables program (import/reconcile) |
| `/api/v1/chain-adapter/transactions/build` | `{chainId, from, to, asset:"erc20:<contract>"\|"spl:<mint>", value}` | stables transfer (phase 1) |
| `/api/v1/chain-adapter/transactions/submit` | `{chainId, signedTx}` | stables sign (phase 2) |
| `/api/v1/chain-adapter/transactions/status` | `{chainId, txId}` | stables sign polling |

Callers configure the base URL with units-api `ORCHESTRATOR_URL` and engine `ADAPTER_ORCHESTRATOR_URL`.

**Adding a chain or external system**: deploy an adapter service that implements the interface, then upsert an `adapter_registry` row listing its CAIP-2 ids (`ON CONFLICT (adapter_id)` seed pattern). Add the network to `chain_registry` (units-api seed `04-chain-registry.sql`) if it's new.

Config: `APP_CONFIG={"APP_HOST","APP_PORT":8090,...}`, `DB_PROVIDER=postgresql`, `DB_CONFIG`, `LOG_LEVEL` (debug logs full payloads). Pool 10 idle / 100 open.

Gaps: **no timeout** (default `http.Client{}`), no failover across priorities (only the top row is tried), no health checks, no caching. The alchemy adapter's source isn't in these repos.

---

## 14. keycloakDelegatedAuth: "Login with Finternet" (Keycloak authenticator SPI)

This is **not** RFC 8693 token exchange. It's a Keycloak 26.4.1 Authenticator SPI (Java 17, provider id `delegate-to-app`). Keycloak stays the OIDC Authorization Server for **third-party RP clients**, while login, signup and consent UX happen in finternet-app and its BFF. It's bound **per client** through the `delegated browser` flow (`authenticationFlowBindingOverrides.browser`), never realm-wide. The registry's `POST /v1/oidc/clients` creates such clients.

Flow:
1. RP → KC `/auth` → `authenticate()`.
   - Optional SSO-cookie user. It computes `consent_scopes` / `missing_consent_scopes`.
   - `prompt=none`: a cookie user succeeds silently; no cookie user → `login_required`.
   - Otherwise it builds a **kc_request** JWT (realm RS256 key; `iss, aud` (app origin), `iat, exp` (+600 s), `nonce`, `client_id`, `client_name`, `scope`, consent arrays, `prompt_consent`, `require_login`, `login_hint?`, `callback_url`, `tab_id`) and 302s to `{app-login-url}?kc_request=<jwt>`.
2. The app runs login/signup and consent. The BFF mints an RS256 **assertion** (`typ delegated-auth+jwt`, `iss finternet-app-bff-oidc`, `aud` realm issuer, ≤120 s life, single-use `jti`, `nonce` echo, `kc_user_id`, `kc_username`, `did`, `finternet_address`, `approved_scopes`, `client_id`). The browser **form-POSTs** `assertion` to `callback_url`. Query-string assertions are rejected. Deny → `error=access_denied`.
3. `action()` verifies the assertion:
   - alg pinned RS256; key by `kid` from `bff-jwks-url` (300 s cache) or `static-public-key-pem`; fails closed otherwise.
   - Checks typ, iss, aud, times, nonce, and jti replay (`SingleUseObjectProvider`).
   - Resolves the user by `kc_user_id` + username cross-check. **Users are never created here.**
   - Stamps `did` / `finternet_address` attributes (write-if-absent).
   - Records consent for all consent-screen scopes and strips `prompt=consent`.
   - Success → KC issues the code.

Third-party consent also materialises **delegations** in the registry (`/v1/oidc/consent`), so the RP (grantee type `oidc-client`) can act on the user's labelled resources.

Config (`KC_SPI_AUTHENTICATOR__DELEGATE_TO_APP__<OPTION>` or the per-execution alias `delegate-to-app-config`): `app-login-url` (required), `bff-jwks-url`, `bff-issuer`, `static-public-key-pem`, `request-jwt-lifespan` 600, `assertion-max-age` 120, `clock-skew` 30, `stamp-email` false, `stamp-attributes` true.

Build: `mvn package` → `target/keycloak-delegated-auth.jar` (`mvn test` for JUnit 5 + Mockito). Docker targets `artifact` (busybox jar for an init container into `/opt/keycloak/providers`) and `keycloak` (KC 26.4.1 + jar).

Gaps: `amr` is informational. No JIT user creation.

---

## 15. Known gaps by component (summary)

| Component | Gap |
|---|---|
| Whole platform | No webhooks or event egress. No API idempotency key. Kafka key = txId means no per-token ordering. |
| primitive-operation | STUCK needs manual ops. Plan-hash parity between TS and Go is fragile (`prunesOpSeq` absent vs `[]`, `name` in participants). `proxy_record` has no compensation. |
| delegation | Fan-out disabled when `RECONCILE_PEER_URLS` is empty. `delegation-activate` is dead but registered. |
| profile-update | User JWT replayed across OTP waits. |
| units-api outbox | Never dead-letters. Prune is best effort. |
| engine (completion) | Unsigned callbacks if signing env is missing → 401 at units-api. DLQ context bug. |
| registry | No auto-migration. Per-replica rate limits. Key rotation planned. |
| proofService | Waits for a full batch. No anchoring. Health port unused. |
| notificationService | In-memory mock store. |
| adapterOrchestrator | No timeout or failover. |
| keycloakDelegatedAuth | Users must pre-exist. |
