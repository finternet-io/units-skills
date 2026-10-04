# Local development (internal engineers)

This file covers building, testing, running and debugging UNITS on a laptop: per-repo commands, the docker-compose stack, seeding, end-to-end debugging with SQL, and contribution conventions. **Cloud deployment is out of scope.** Snapshot 2026-10-03. Makefiles and compose files change, so check them before you trust a port or a flag.

> House rules from `units-api/AGENTS.md`:
> - **Never tear down or restart the shared local Docker stack, and never kill the process on :3000.** Concurrent work depends on it.
> - The units-api e2e suite runs `docker compose down -v` on exit. See §2.1 before you run it.
> - Put repeatable verification flows in committed scripts under `scripts/`, not `/tmp`.
> - Produce a gap analysis before sizeable work.
> - Work on a fresh branch.
> - Verify against the real local stack (API on :3000, real Keycloak and Postgres), not stubs.

---

## 1. Workspace layout

Clone the repos **side by side** under one parent directory. Compose overlays mount sibling paths.

```
<parent>/
  units-api/            Go/Fiber API, owns the instance DB schema (Flyway V-files), local compose stack
  units-token-runtime/  Rust token engine (tokenEngine/) + token programs (tokenPrograms/)
  units-workflows/      TypeScript Restate workflows (gateway, primitive-operation, delegation, profile-update)
  units-services/       registry (Go), proofService (Rust), notificationService (Node), adapterOrchestrator (Go), keycloakDelegatedAuth (Java)
  units-automation/     only needed for the tests/smoke two-instance harness + throwaway smoke keys used by the registry overlay
  finternet-app/        Next.js wallet UI + BFF (optional for backend work)
```

Override sibling paths in `units-api/manifests/docker-compose/.env` if your layout differs: `UNITS_REGISTRY_DIR=/abs/path/units-services/registry` and `UNITS_AUTOMATION_DIR=/abs/path/units-automation`.

Toolchains: Go 1.25, Rust stable (cargo, clippy, rustfmt; cmake for `rdkafka`), Node ≥24 + npm (workflows), Node ≥18 (notificationService), Java 17 + Maven (keycloakDelegatedAuth), Docker with compose v2, `psql`, `jq`. Optional: `newman` (Postman), `golangci-lint`, `swag`, `air`, `opa`, `b3sum`.

---

## 2. Repo-by-repo commands

### 2.1 units-api (Go)

| Task | Command | Notes |
|---|---|---|
| Run from source | `CGO_ENABLED=0 make start` (or `make start-dev` with `air`) | **macOS arm64: `CGO_ENABLED=0` is mandatory.** gopsutil's `go-m1cpu` cgo init segfaults at package init. |
| Build | `make build` | writes `bin/units-workflow` (historical name) |
| Unit tests | `make test-unit` | pins `CGO_ENABLED=0` → the sqlite-backed unit tests fail without a cgo driver (~147–158 pre-existing failures). **Write new unit tests DB-free.** |
| E2E tests | `make test-e2e` / `make test-quick` / `make test-specific TEST=TestName` | **Not hermetic**: `TestMain` runs `docker compose up -d --build` against real Keycloak 26.5.6, Postgres 17, Vault, MinIO, Kafka and Restate (only the registry is stubbed), and **`docker compose down -v --remove-orphans` on exit**. That wipes volumes and kills a shared stack. About 90 pre-existing failures (harness OTP JWT lacks `kid`). Diff failing test **names** against the base commit, not counts. |
| Session/refresh e2e against a running stack | `make test-session-e2e` (`scripts/e2e-session-tests.sh`) | Uses a compose shim, so it doesn't tear the stack down |
| OPA policy tests | `make opa-test` | `opa test src/authz/policies/ -v` |
| Lint / format | `make lint` (golangci-lint) / `make fmt` (go fmt + goimports) | |
| Swagger | `make swagger` → served at `/v1/docs/` | Partly stale |
| Postman scenarios | `make postman-test [SCENARIO="A. Token Lifecycle"]` | newman + `manifests/postman/environment-local.json` |
| DB | `make db-migrate`, `make db-seed`, `make db-seed-users`, `make db-shell`, `make db-reset` | **The Makefile default `DATABASE_URL` (`postgres://units:units@localhost:5433/units`) doesn't match the compose DB.** Export `DATABASE_URL=postgres://postgres:<POSTGRES_PASSWORD from .env.docker>@localhost:5432/postgres` first. |
| Docker image | `make docker-build` | buildx multi-arch publish build. Use plain `docker build` for a local image. |

CI notes:
- The CI e2e job never starts Postgres, Vault or Keycloak, and is `continue-on-error` (#221). **Unit tests are the only effective gate.**
- Live-stack scripts in `scripts/` aren't wired into CI.
- Useful scripts: `scripts/test-api.sh`, `scripts/sign-transact.sh` (sign a transact payload with a self-managed Ed25519 key), `scripts/test-refresh-token.sh`, `scripts/rbac_*`, and `scripts/seed/register-users-via-api.sh`.

`units-api/CLAUDE.md` is partly stale. Its "Bootstrap" section (`/v1/api-clients/*`, `allowedDeveloperTokens`) describes a model that's been replaced by registry-resolved SA credentials. Its claim that "E2E uses SQLite" is also wrong.

### 2.2 units-token-runtime (Rust)

| Task | Command |
|---|---|
| Build all | `make build` (= `cd tokenPrograms && cargo build --all` + `cd tokenEngine && cargo build`) |
| Test all | `make test` (`test-programs`: `cargo test --all` in tokenPrograms; `test-engine`: `cargo test` in tokenEngine) |
| One program | `cd tokenPrograms && cargo test -p token-program-<name>` |
| Lint / format | `make lint` (`cargo clippy --all-targets --all-features` in both workspaces) / `make fmt` |
| Engine image | `make docker-build [TAG=...]` (buildx multi-arch publish build). Locally use `docker build -f tokenEngine/Dockerfile -t token-engine:local .` from the repo root so the image loads into your daemon. |
| Own infra (Postgres 18 + Kafka) | `make infra-up` / `make infra-down` (**`down -v`**). Ports collide with the units-api compose (5432, 9092), so don't run both. Prefer the units-api stack. |
| Schema / seeds (standalone only) | `make db-migrate` / `make db-seed` (`DATABASE_URL` defaults to a local `postgres` DB on `localhost:5432`; see the Makefile). These are copies. **units-api owns the real DDL**, and `primitive_ops` exists only there. |
| Legacy producer | `make kafka-produce ARGS="mint USDC"`. **Rejected by the current engine** (no federation context). Use it only for reading. |

Engine env is JSON-in-env:
- `DATABASE_CONFIG='{"url":"postgres://...","maxConnections":10}'`
- `KAFKA_CONFIG='{"brokers":"localhost:9092","topic":"units.token.operations","consumerGroup":"token-engine","dlqTopic":"units.token.operations.dlq","dlqEnabled":true,"auditTopic":"units.token.events","auditEnabled":false}'`
- `HEALTH_PORT` (8080 compose / 8081 `.env.example`), `RUST_LOG`, `ADAPTER_ORCHESTRATOR_URL`, plus the completion-signing vars (§4.3).

See `tokenEngine/.env.example`. Health: `GET :HEALTH_PORT/health/live`, `/health/ready`, `/health`.

### 2.3 units-workflows (TypeScript)

| Task | Command |
|---|---|
| Install | `npm install` (npm workspaces) |
| Build / test | `make build` / `make test` (turbo); one app: `npx turbo run test --filter=@units/primitive-operation` |
| Dev | `npx turbo run dev` (tsx watch). Run one app with `WORKFLOW_NAME=gateway` semantics: the gateway hosts all workflows. |
| Types / lint | `npm run check-types` / `npm run lint` |
| Image | `make docker-build` (entrypoint selects `apps/$WORKFLOW_NAME`) |
| Own infra | `make infra-up` (Postgres :5433, Restate ingress :8082, admin :9070). Collides with the units-api compose Restate, so don't run both. |

Needs Restate, Postgres (Prisma, units-api schema) and a reachable units-api. `CLAUDE.md` is stale: it lists only gateway and profile-update, and says Node ≥20.

### 2.4 units-services

| Service | Build | Test | Notes |
|---|---|---|---|
| all | `make build` | `make test` | top-level Makefile: Go build, `npm ci`, `cargo build` |
| registry (Go) | `cd registry && make build` / `make start` | `make test-unit`; `make test-integration` (own compose) | `make db-migrate` needs `$DB_URL`. **No auto-migration.** Local image for the units-api overlay: `docker build -t units-registry:local units-services/registry` (its own `make docker-build` tags `units-registry:latest`). |
| proofService (Rust) | `cargo build` | `make test-proof` | Needs `DATABASE_URL` and the units-api schema |
| notificationService (Node) | `npm ci` | `make test-notification` | `MOCK_OTP_ENABLED=true` → OTP `123456`; requires `JWT_PRIVATE_KEY` PEM |
| adapterOrchestrator (Go) | `go build ./...` | `make test-orchestrator` (`go test -v ./tests/...`) | |
| keycloakDelegatedAuth (Java) | `mvn package` | `mvn test` | jar → `/opt/keycloak/providers` |

`units-services/docker-compose.yml` runs Postgres 18 (:5432, with the adapter registry DDL and seed) for notification and orchestrator dev. `registry/docker-compose.yml` runs the registry plus Postgres (:5440).

### 2.5 finternet-app (only if you need the UI)

`corepack enable && pnpm install && pnpm db:generate && pnpm docker-up` (Postgres :5433 only), then `pnpm db:migrate && pnpm db-seed`, then put local overrides in `config/overrides.yaml` (gitignored: dev SA token, registry dev token, `proxy.registryTargetUrl http://localhost:3100`, ...), then `pnpm dev` (UI :3002, BFF :6000).
- Port clash: the app's wallet backend default `:8090` collides with the units-api compose adapter-orchestrator.
- Commit convention: `<type> #<issue>: <message>`.

---

## 3. Running the stack (units-api compose)

Files:
- `units-api/manifests/docker-compose/docker-compose.yaml`: base, with profiles.
- `docker-compose.registry.yaml`: **required overlay**. Current units-api images refuse to boot without `REGISTRY_BASE_URL` / `REGISTRAR_PUBKEY` / `ULIP_SIGNING_PRIVATE_KEY`.
- Env file `.env.docker`: `cp .env.docker.example .env.docker` on first use. It contains local-only defaults such as `FEATURE_FLAGS`, `MOCK_OTP_ENABLED=true` and `TWILIO_ENABLED=false`.

```bash
# 0. one-time: local registry image the overlay expects
docker build -t units-registry:local ../units-services/registry      # from units-api/

cd units-api/manifests/docker-compose
cp -n .env.docker.example .env.docker

# 1. full single-instance stack: infra + API (built from source) + OTP + engine + registry
docker compose -f docker-compose.yaml -f docker-compose.registry.yaml \
  --profile api-infra --profile app --profile otp --profile engine up -d

# add workflows (Restate + workflow-orchestrator): --profile services   (see §4.2: needs an override for token ops)
# add on-chain features: --profile chain-adapter --profile adapter-orchestrator

# 2. alternative: registry only, and run units-api from source on the host
docker compose -f docker-compose.yaml -f docker-compose.registry.yaml up -d registry-db registry
```

Makefile shortcuts (`units-api/Makefile`) use the base file **without** the registry overlay: `make infra-up`, `api-up`, `engine-up`, `services-up`, `docker-all`, `docker-ps`, `docker-logs SVC=app`. **`make docker-down` / `docker-down-clean` stop or wipe everyone's stack. Don't run them on a shared machine.**

### 3.1 Services and ports

| Service | Profile | Host port(s) | Notes |
|---|---|---|---|
| `db` (postgres:17) | always | 5432 | DB `postgres`, user `postgres` (password in `.env.docker`). initdb applies `specs/db` V01–V09, V11, V14, V15 on a **fresh volume only** (V12 `terms_consent` isn't mounted; apply it by hand if you need terms endpoints). |
| `hyperdx` (ClickStack) | always | 8081 (UI), 4317/4318 (OTLP) | traces and logs for every service |
| `kafka` (apache/kafka 4.1.1, KRaft) + `kafka-init` | always | 9092 (host), 29092 (in-network) | creates `units.token.operations` ×4, `.dlq` ×1, `units.token.events` ×4 |
| `minio` | api-infra | 9005 (S3), 9001 (console) | DID docs, images |
| `keycloak` 26.5.6 | api-infra | **127.0.0.1:8080**, 9000 | `start-dev --import-realm` of `keycloak/finternet-realm.json`, with the feature flags set in the compose file (required for login; don't change them) |
| `vault` | api-infra | 8200 | dev init via `scripts/start-and-init-vault.sh` (transit for PII and per-account signing keys) |
| `restate` 1.3 | api-infra, services | 8082 (ingress), 9070 (admin) | ingress remapped to avoid Keycloak's 8080 |
| `otp-service` | otp | 4000 | mock OTP `123456` |
| `app` (units-api, built from source) | app | 3000 | `LOCAL_INSTANCE_ID=00000000-0000-4000-8000-000000000001`, `LOCAL_INSTANCE_NAME=local-dev`, `PUBLIC_API_URL=http://localhost:3000` (must equal the realm's `instance_url` mapper), `RESTATE_INGRESS_URL=http://restate:8080`, `ORCHESTRATOR_URL`/`ADAPTER_ORCHESTRATOR_URL=http://adapter-orchestrator:8090` |
| `token-engine` | engine | — (health 8080 in-container) | **pulls the published `token-engine:latest` image, not your local build** (§4.1) |
| `workflow-orchestrator` + `-init` | services | — | **runs `WORKFLOW_NAME=profile-update` only** (§4.2) |
| `chain-adapter` | chain-adapter | 3500 | Alchemy-backed |
| `adapter-orchestrator` | adapter-orchestrator | 8090 | |
| `registry-db` (postgres:17) | overlay | — | self-provisions registry schema V01–V13 + `R__scope_catalogue.sql` + `R__rate_limit_defaults.sql` + local dev credentials |
| `registry` (`units-registry:local`) | overlay | 3100 | `REGISTRAR_NAMESPACE=registrar.finternet.lab`, TOFU bootstrap on, dev registrar key from `units-automation/tests/smoke/registry-keys` (throwaway) |

### 3.2 Seeding

1. **Instance DB schema**: automatic on a fresh `db` volume. For an existing volume, run `make db-migrate` with the right `DATABASE_URL`. It uses `|| true`, so read the output for errors.
2. **Reference data**: `make db-seed` runs `scripts/seed/*.sql` in order:
   - `01-token-programs.sql` (placeholder rows; the engine overwrites them at boot)
   - `02-token-classes.sql` (27 classes + configs: stablecoin PROXY-FT classes, NFH-T, CREDENTIAL, SODEXO-MV, LOAN-NFT, LOAN-POOL)
   - `04-chain-registry.sql`, `05-wallet-provider-registry.sql`, `06-adapter-registry.sql`
   - `08-delegation-workflows.sql`, `11-scope-approval-workflows.sql`
3. **Users**: `make db-seed-users` (`scripts/seed/register-users-via-api.sh`). It drives login → OTP `123456` → create for businesses (`circle-treasury`, `nfh-treasury`, `realassets-admin`, ...) and individuals (`alice`, `bob`, ...). Its default `DEVELOPER_TOKEN` is **obsolete**. Pass a real local SA token.
4. **Developer (SA) credentials**: the registry overlay seeds two **fixed local-dev fixtures** in `units-api/manifests/docker-compose/registry/initdb/10-local-dev-credentials.sql`. Read the token values there. Don't copy them into docs or commits.
   - `local-dev-manage`: `accounts:create`, `accounts:manage`, `accounts:view`.
   - `local-dev-noscope`: `accounts:create` only, as a 403 negative.

   Neither is a superadmin, on purpose, so the scope gate is exercised. **They can't call token or class endpoints.** For token work locally,
   insert your own scoped client into `registry-db` following the same pattern (`developer_clients` + `developer_keys` with `key_hash = sha256("sa-<uuid>:<secret>")`, `kind='sa_secret'`; scopes such as `tokens:create`, `tokens:transact`, `tokens:view`, `tokenClasses:create`, `tokenClassConfigs:create`, `internal:manage`).
5. **Accounts and sessions**: `POST /v1/account/login {username}` then `{username, otp:"123456"}`. Use `/v1/account/create {address, name, entityType:"PERSONAL"|"BUSINESS"}` with the OTP JWT if `isExisting:false`.
6. **Capability document**: units-api publishes it at boot from `token_programs` rows with `selfRegistered:true`, which means the **engine must have booted first**. If the engine started after the API, re-publish: restart `app`, send SIGHUP, or `POST /v1/registry/capability/publish` (needs `internal:manage`). Otherwise every token op fails `primitive_capability_missing`.

### 3.3 Local Keycloak

- Realm `finternet`, client `units`.
- **Realm import only runs if the realm doesn't exist.** Editing `finternet-realm.json` needs a fresh `keycloak-data` volume locally.
- Lifespans (see `keycloak/README.md`): access up to 24 h but capped by the 10 h SSO max (`expires_in` 36000), refresh idle 30 min, `revokeRefreshToken:true`, `refreshTokenMaxReuse:0` (single-use; replay → `SESSION_REVOKED`). Refresh on a timer under 30 min, with a single-flight lock.
- `/userinfo` returns 403 for UNITS session tokens (no `openid` scope). That doesn't mean the session is dead.
- Docs: `units-api/docs/refresh-token-local-testing.md`.

---

## 4. Making token operations actually complete locally

A mint or transact passes through units-api → Restate `primitive-operation` → ULIP → `primitive_ops` outbox → Kafka → engine → signed completion → Restate signal. The stock compose leaves three gaps.

### 4.1 Use your engine build

The `token-engine` service pulls the published `token-engine:latest` image. To test program changes, either:
- build `docker build -f tokenEngine/Dockerfile -t token-engine:local .` (in `units-token-runtime/`) and point the service at it with a compose override (`image: token-engine:local`), or
- stop only that container and run the engine from source against the published ports: `cd tokenEngine && DATABASE_CONFIG='{"url":"postgres://postgres:<pw>@localhost:5432/postgres"}' KAFKA_CONFIG='{"brokers":"localhost:9092","topic":"units.token.operations","consumerGroup":"token-engine"}' HEALTH_PORT=8085 cargo run`.

The completion target must then be reachable from the host. Alternatively, run units-api from source as well.

After the engine boots, check `SELECT program_id, config->'selfRegistered' FROM token_programs;` and re-publish the capability document (§3.2 step 6).

### 4.2 Run the primitive-operation workflow

The compose `workflow-orchestrator` runs `WORKFLOW_NAME=profile-update` with an obsolete `DEVELOPER_TOKEN` and the published `units-workflows:latest` image. So **`primitive-operation` isn't served, and every mint or transact stays `submitted`** (Restate ingress 404s `primitive-operation/<txId>/run/send`; check the units-api logs). Use a local override like this:

```yaml
# units-api/manifests/docker-compose/docker-compose.override.local.yaml  (don't commit secrets)
services:
  workflow-orchestrator:
    image: <published workflow-orchestrator image, or a local build>
    environment:
      WORKFLOW_NAME: gateway                    # hosts primitive-operation, delegation(+revoke), profile-update
      PORT: 9080
      WORKFLOW_API_URL: http://app:3000
      ULIP_BASE_URL: http://app:3000
      LOCAL_INSTANCE_ID: 00000000-0000-4000-8000-000000000001   # = app's LOCAL_INSTANCE_ID
      ULIP_SIGNING_PRIVATE_KEY: <same value as app's, from docker-compose.registry.yaml>
      ULIP_SIGNING_KEY_ID: ed25519-key-1
      DEVELOPER_TOKEN: <a local SA token that can call /v1/internal/* (see §3.2 step 4)>
      REGISTRY_BASE_URL: http://registry:3000
      REGISTRAR_NAMESPACE: registrar.finternet.lab
      # plus any remaining registry client settings, copied from docker-compose.registry.yaml
      RECONCILE_PEER_URLS: '{"00000000-0000-4000-8000-000000000001":"http://app:3000"}'
      DATABASE_URL: postgresql://postgres:<pw>@db:5432/postgres
      OTP_SERVICE_URL: http://otp-service:4000
```

Then run: `docker compose -f docker-compose.yaml -f docker-compose.registry.yaml -f docker-compose.override.local.yaml --profile services ... up -d workflow-orchestrator workflow-orchestrator-init`. The init container registers `http://workflow-orchestrator:9080` with Restate admin. Re-run it, or `curl -X POST localhost:9070/deployments -H 'content-type: application/json' -d '{"uri":"http://workflow-orchestrator:9080","force":true}'`, whenever you add a workflow.

Running the gateway from source instead: `cd units-workflows && npm install && make build`, export the same env (with `localhost` URLs), and run `node apps/gateway/dist/app.js` (or `npx turbo run dev --filter=@units/gateway`). Register `http://host.docker.internal:9080` with Restate admin.

Check: `SELECT workflow_name, restate_service FROM workflow_registry;` should list `primitive-operation`.

### 4.3 Signed completion callbacks

units-api **requires signed completions**. Unsigned callbacks get `401 primitive_completion_signature_required`. The stock `token-engine` service sets none of the signing vars. Give it:

```
LOCAL_INSTANCE_ID=00000000-0000-4000-8000-000000000001        # signer_instance must equal callee_instance
PRIMITIVE_COMPLETION_SIGNING_KEY=<same Ed25519 seed as app's ULIP_SIGNING_PRIVATE_KEY>
PRIMITIVE_COMPLETION_SIGNING_KEY_ID=ed25519-key-1
```

The registry resolves the instance public key that units-api published through TOFU, so the engine must sign with the **same** key. Symptoms when this is wrong: `primitive_ops.engine_status='executed'` but `completion_status='failed'` with a 401 in `completion_error`, and the workflow times out after 30 s → ABORTED, even though the token row changed.

### 4.4 Smoke test

Login as an issuer → register a class + config (or use seeded NFH-T as `nfh-treasury`) → `/v1/token/mint` → poll `/v1/transaction/status` until `completed` → `/v1/transaction/get` for the tokenId. Postman `02 Scenarios / A. Token Lifecycle` automates this: `make postman-test SCENARIO="A. Token Lifecycle"`.

---

## 5. Postman, scripts and the federation harness

- **Postman**: `units-api/manifests/postman/finternet-api-collection.json` with `environment-local.json` (`http://localhost:3000` + federation topology) and `environment-dev.json`. Sections: `01 API Catalog` (every request by domain) and `02 Scenarios` (Token Lifecycle, Payment Transfers, RBAC Delegation, Scope Approval, Loan Lifecycle, Federation Transfer, Federation Auth). README in the same folder.
- **Two-instance federation e2e**: `units-automation/tests/smoke` (`docker compose build && docker compose up -d --wait`, then `./smoke.sh` / `./smoke-reversal.sh`). It builds units-api, units-workflows, units-token-runtime and the registry from sibling checkouts and runs instances a/b with their own Postgres, Kafka and Restate. Mention it, run it when you touch federation, and read its README. It's separate from the single-instance stack above, and its ports overlap.

---

## 6. Debugging a transaction end to end (SQL)

Connect with `make db-shell` (correct `DATABASE_URL`) or `docker compose exec db psql -U postgres -d postgres`. Replace `:tx` with the `txId` (= `transactions.id` = Restate workflow id = `primitive_ops.txn_id`).

```sql
-- 1. API-side transaction + federation lifecycle + error
SELECT id, status, status_v2, error, initiator, workflow_instance_id,
       metadata->'affectedTokenIds' AS token_ids, timestamps, created_at, updated_at
FROM transactions WHERE id = :'tx';

-- 2. the plan units-api built (template, steps, participants)
SELECT plan_data->'templateName', plan_data->'steps', plan_data->'primitiveOps'
FROM transactions WHERE id = :'tx';

-- 3. per-primitive admission, Kafka command, engine result, completion, Restate signal
SELECT op_seq, method, admit_status, admit_error,
       command_status, command_attempts, command_error, command_sent_at,
       engine_status, engine_result, engine_executed_at,
       completion_status, completion_attempts, completion_error, completion_sent_at,
       signal_status, signal_attempts, signal_error
FROM primitive_ops WHERE txn_id = :'tx' ORDER BY op_seq;

-- 4. Restate-side workflow record + per-op audit
SELECT txn_id, workflow_name, status, last_error, retry_attempts, outcome FROM workflows WHERE txn_id = :'tx';
SELECT op_seq, op_type, details, result, created_at FROM workflow_ops WHERE txn_id = :'tx' ORDER BY op_seq;

-- 5. ledger rows written by the engine (operation = resolved inner verb; prepare rows may be pruned)
SELECT token_id, operation, entry_type, participants, units, timestamp
FROM token_transactions WHERE tx_id = :'tx';

-- 6. the token(s) now
SELECT id, token_class, token_standard, identities, state, data, state_version, state_commitment, last_tx_id
FROM tokens WHERE id IN (SELECT jsonb_array_elements_text(metadata->'affectedTokenIds')::uuid
                         FROM transactions WHERE id = :'tx');

-- 7. commitment chain for a token (previous_commitment of v(n) must equal state_commitment of v(n-1))
SELECT state_version, state_commitment, previous_commitment, commitment_config, token_tx_id, timestamp
FROM state_history WHERE token_id = :'token' ORDER BY state_version;

SELECT h.state_version, h.previous_commitment = p.state_commitment AS chain_ok
FROM state_history h LEFT JOIN state_history p
  ON p.token_id = h.token_id AND p.state_version = h.state_version - 1
WHERE h.token_id = :'token' ORDER BY h.state_version;

-- 8. audit trail
SELECT event_type, action, actor, changes->'changedFields', timestamp FROM audit_events
WHERE context->>'txId' = :'tx' ORDER BY timestamp;

-- 9. class -> config -> program binding (most "nothing happens" bugs live here)
SELECT c.token_class, c.token_standard, c.metadata->'fungible' AS fungible, c.identities,
       cfg.program_id, cfg.status, cfg.pre_hooks, cfg.config,
       p.supported_standards, p.supported_operations, p.config->'selfRegistered' AS self_reg
FROM token_classes c
LEFT JOIN token_class_configs cfg ON cfg.token_class = c.token_class
LEFT JOIN token_programs p ON p.program_id = cfg.program_id
WHERE c.token_class = 'WARRANTY';

-- 10. stuck work
SELECT txn_id, op_seq, method, command_status, command_attempts, command_error FROM primitive_ops
WHERE command_status IS DISTINCT FROM 'sent' AND command_status IS NOT NULL ORDER BY created_at DESC LIMIT 20;
SELECT txn_id, op_seq, completion_status, completion_attempts, completion_error FROM primitive_ops
WHERE completion_status IN ('pending','failed') ORDER BY created_at DESC LIMIT 20;
SELECT id, status, status_v2, created_at FROM transactions
WHERE status IN ('pending','processing') AND created_at < now() - interval '2 minutes' ORDER BY created_at DESC;

-- 11. tokens owned by an account (hash = sha256(lower(trim(address))))
SELECT id, token_class, state->>'balance', state->>'status' FROM tokens
WHERE identities @> '[{"type":"owner","id":"<address sha256>"}]';

-- 12. proofs (pending until MERKLE_BATCH_SIZE completed txs accumulate)
SELECT t.id, t.proof_id, p.status, p.state_commitment AS merkle_root FROM transactions t
LEFT JOIN proofs p ON p.id = t.proof_id WHERE t.id = :'tx';
```

Other tools:
- **Kafka**:
  - `docker exec -it units-kafka /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server localhost:9092 --topic units.token.operations.dlq --from-beginning`. In DLQ entries, read `original_payload.txId` because `context.tx_id` is always null (bug).
  - `--topic units.token.operations --property print.key=true` shows live commands.
  - `kafka-consumer-groups.sh --describe --group token-engine` shows lag.
- **Restate**: the admin API is on `localhost:9070` (`GET /deployments`, `GET /services`). The Restate CLI, if installed, lets you inspect invocations and journals of `primitive-operation/<txId>`.
- **Logs and traces**: HyperDX at `http://localhost:8081`, or `docker compose logs -f app token-engine workflow-orchestrator`. Useful grep keys: `domain_lifecycle_source_capability_lookup_failed`, `outbox_delivery_stuck`, `primitive_completion_signal_failed`, `completion_signer_disabled`, `default_program_registered`, `restate_self_register_skipped`.

Reading the result:

| Observation | Meaning |
|---|---|
| `transactions.status='pending'`, no `primitive_ops` rows | The workflow never ran (Restate not reachable, `primitive-operation` not served, or deployment not registered) |
| `admit_status` error | ULIP admission refused (signature, plan hash, capability) → see `admit_error` |
| `command_status` not `sent` | Outbox can't reach Kafka |
| `engine_status` NULL with `command_status='sent'` | Engine not consuming (down, wrong topic or group, or crashing on deserialize → DLQ) |
| `engine_status='failed'` | Program, hook or validation error → `engine_result.errorCode` and `transactions.error` |
| `engine_status='executed'`, `completion_status='failed'` | Callback can't reach or isn't accepted by units-api (signing, §4.3) |
| `status_v2` `stuck` | Post-PONR uncertainty. Resolve by hand. |

---

## 7. Common local failures and fixes

| Symptom | Cause | Fix |
|---|---|---|
| units-api exits at boot complaining about `REGISTRY_BASE_URL` / `REGISTRAR_PUBKEY` / `ULIP_SIGNING_PRIVATE_KEY` | Started without the registry overlay | Add `-f docker-compose.registry.yaml` |
| `registry` container: image `units-registry:local` not found | Not built | `docker build -t units-registry:local units-services/registry` |
| Every call → `503` | Registry down or unreachable (dev-token resolution fails closed) | Check `registry` health on :3100 |
| `401` invalid developer token / `403 CLIENT_INSUFFICIENT_SCOPE` | Wrong token, or a local fixture SA without token scopes | §3.2 step 4 |
| `500 SCOPE_MAPPING_NOT_CONFIGURED` | api id missing from the registry scope catalogue | Add a row to `units-services/registry/specs/db/seed/R__scope_catalogue.sql` and re-apply it to `registry-db` |
| `400 primitive_capability_missing` | No class config, program not self-registered, or capability not re-published | Register the class config. Boot the engine. Re-publish (§3.2 step 6). |
| `400 operation_not_supported` | Inner verb not in the published `supportedOperations` | New engine build not published yet, or a typo |
| Mint/transact stuck at `submitted`/`pending` | `primitive-operation` workflow not served | §4.2 |
| Engine executed but tx never completes; completion 401 | Unsigned or wrong-key completions | §4.3 |
| Async `UNSUPPORTED_TOKEN_STANDARD` / `PROGRAM_NOT_FOUND` / `CONFIG_NOT_FOUND` | Class standard not in program whitelist, wrong `programId`, or config status not `active` | Query 9 in §6 |
| `DATA_INTEGRITY_VIOLATION` on the second op of a token | Program commitment bug, or a manual DB edit of `tokens` | `authoring-token-programs.md` §10. Never hand-edit token rows. If you must, rebuild state_history consistently. |
| `CAPABILITY_DENIED` on voucher mint | Known `purpose-bound-voucher` capability bug | Not a local issue |
| Login: 500 / `UnsupportedOperationException` | Keycloak started with a different feature set than the compose file | Use the compose Keycloak command line as-is |
| Realm changes not applied | Import only runs for a missing realm | Recreate the `keycloak-data` volume (your own machine only) |
| OTP never arrives | Expected in mock mode | Use `123456`. The mock store is in-memory, so restarting otp-service invalidates pending OTPs. |
| `go test` segfaults on macOS | cgo `go-m1cpu` | `CGO_ENABLED=0` |
| Local stack suddenly empty | Someone ran units-api e2e (`down -v`) or `make docker-down-clean` | Re-seed (§3.2). Use `make test-session-e2e` / the compose shim next time. |
| Terms endpoints 500 locally | V12 not mounted in compose initdb | `psql ... -f specs/db/V12__terms_consent.sql` |
| `make db-seed` connects to the wrong DB | Makefile default `DATABASE_URL` | Export the compose URL |
| Port clashes (5432, 8080, 8081, 8082, 8090, 9092) | Several composes, or finternet-app wallet backend | Run one stack. See the port table. |
| `primitive_plan_intent_hash_mismatch` | TS/Go plan-hash divergence (e.g. dropped participant `name`, `prunesOpSeq: []`) | Align with `operation_planner*.go` / workflow-utils; don't strip fields |
| Proof stays `pending` | Batch not full | Lower `MERKLE_BATCH_SIZE` when running proofService locally |

---

## 8. Contribution conventions

- **Branching**: start sizeable work on a fresh branch. Drive it to passing tests (and e2e against the local stack where relevant) before calling it done. Produce a written gap analysis with a mitigation per gap for sizeable work.
- **CHANGELOG**: every repo keeps `CHANGELOG.md` with date-versioned release blocks `## [YYYY.MM.DD] — YYYY-MM-DD` and `### Added / Changed / Fixed / Removed`. Each bullet is a bold summary, the PR number(s), then what and why. Add your entry in the same PR.
- **Database migrations: units-api owns the instance schema.**
  - New or changed tables go in `units-api/specs/db/V<NN>__<description>.sql`, using the next number (gaps exist: V10, V13).
  - Add the file to the `db-migrate` target in `units-api/Makefile` **and** to the `db` initdb mounts in `manifests/docker-compose/docker-compose.yaml`.
  - Add the GORM model in `src/models/`.
  - Deployed environments apply these through the unified Flyway job.
  - The copies in units-token-runtime (`specs/db/V01/V02`) and the units-workflows Prisma baseline are **views, not owners**. Update them to match, but never migrate from them.
  - The registry schema lives in `units-services/registry/specs/db` (V-files + `seed/R__*.sql` repeatables).
- **New API endpoint**:
  - Request/response types, JSON schema in `src/schemas/definitions/`, service, controller, route in `src/routers/<domain>.go`, DI wiring in `src/containers/`, unit tests (DB-free) and e2e.
  - **Add the api id → scope row to the registry scope catalogue** (units-services), or the endpoint fails closed with `SCOPE_MAPPING_NOT_CONFIGURED`.
  - Update `specs/api/*.yaml` and the Postman collection.
- **New token program or hook**: follow `authoring-token-programs.md`.
- **New workflow**: follow `workflows-and-services.md` §2.3.
- **Ask before breaking changes.** Before changing any of these, ask the user or owning team about backward compatibility (in-flight Restate journals, older federation peers, existing `state_history` rows, integrators' payloads):
  - Kafka message shapes, `TokenProgram`/interface types, commitment inputs
  - ULIP envelopes, signing inputs or plan-hash rules
  - DB columns or tables
  - public request/response schemas, error codes
  - registry signed-record formats
- **Secrets**: never commit tokens, keys or `.env.docker` edits containing real values. Local fixtures (dev SA credentials, smoke registrar keys) are throwaway and must not be reused elsewhere. Reference them by path, don't copy them.
- **Docs drift**: many repo `CLAUDE.md` / README files are stale (see the notes in each section). When you fix behaviour, update the nearest doc or this skill's references.
