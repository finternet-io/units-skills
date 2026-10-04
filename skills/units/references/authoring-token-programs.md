# Authoring token programs (internal engineers)

This guide covers building a new Rust token program, or a new hook, for the UNITS token engine (`units-token-runtime`) and wiring it end to end through `units-api`. It's written for Finternet engineers who change UNITS code. External integrators can't deploy programs. They pick an existing one (see `token-programs.md`).

Snapshot: 2026-10-03 (token-runtime `main` ~2026-07-07, units-api HEAD ~Sep/Oct 2026). **The code is the source of truth.** Most markdown in `units-token-runtime` (`tokenPrograms/CLAUDE.md`, `README.md`, `DEVELOPMENT.md`, `tokenEngine/CLAUDE.md`, `EXECUTION_FLOW.md`) is stale. It still describes `reference-ft`, an `OperationType` enum, single-message `transfer`, `amount`, a top-level `initiator` field and env vars like `KAFKA_BROKERS`. Don't copy from those docs.

> **Ask before you break compatibility.** Changes to the Kafka `TokenOperationMessage`, the `TokenProgram` trait or interface types, the commitment preimage, DB tables (Flyway DDL in units-api), ULIP primitive methods, or the capability document are cross-repo contracts. Before you change them, ask the user (or the owning team) whether old messages, old `state_history` rows and other federation instances on older builds must keep working. Changing the commitment algorithm or the fields it covers breaks verification of every existing token unless the old config is still honoured.

---

## 1. Mental model

```
client ──POST /v1/token/mint|transact|add──► units-api
   │  auth (dev token + user JWT + scopes + OPA), capability check, plan
   ▼
units-api FederationService.StartDomainLifecycle / StartTransfer
   │  inserts transactions row (status pending, status_v2 submitted), starts Restate workflow
   ▼
Restate "primitive-operation" workflow (units-workflows)
   │  for each plan step: signed ULIP call → POST {instance}/v1/ulip/<Method>
   ▼
units-api ULIP primitive controller → primitive_ops row (txn_id, op_seq) → PrimitiveOutbox
   │  Kafka topic units.token.operations (key = txId)
   ▼
token engine (Rust, tokenEngine) ──► YOUR PROGRAM: execute(ctx, operation, token_state) -> OperationResult
   │  engine persists tokens / token_transactions / state_history / primitive_ops in ONE sql tx
   ▼
signed completion POST {completionTarget}=/v1/internal/primitives/complete → signal workflow → COMMITTED
```

A program is a **pure function**: `(ExecutionContext, Operation, TokenState) -> OperationResult`. The engine does everything else: loading or creating the token, verifying the previous commitment, running hooks, persisting, auditing, updating transaction status, idempotency and completion callbacks.

### 1.1 Non-negotiables

| # | Rule | Why / what breaks |
|---|---|---|
| 1 | **Pure logic. No DB, Kafka, HTTP or `Utc::now()`.** Use `ctx.timestamp` (the Kafka message timestamp) for time. | Determinism and replay. Some existing programs call `Utc::now()`, which is a known bug. Only `stables` does HTTP (through the adapter orchestrator), and it blocks the consumer. |
| 2 | **Static registration.** A crate in `tokenPrograms/programs/<name>`, a workspace member, a registry dependency, and an insert in `ProgramRegistry::register_default_programs()`. Then rebuild the engine image. | There's no plugin, WASM or dynamic loading. `/v1/tokenprogram/register` can create a row, but it **cannot** make an op executable. |
| 3 | **Federation-only ingress.** Every state-mutating message carries `opSeq>0` + `callerInstance` (+ `requestEnvelope`). A domain program's outer verb is always `domain_lifecycle`, so `primitive_capabilities()` **must** include `DomainLifecycle`. Use a preset (§1.3). | Otherwise you get `CAPABILITY_DENIED`, or `InvalidPayload("rejecting state-mutating operation ... no federation context")`. |
| 4 | **Payload through the `PrimitivePayload` SDK.** Use `PrimitivePayload::from_operation(&op)?`. Read your own fields from `extensions.<program-id>` with `.extension::<T>(PROGRAM_ID)`. Don't hand-parse `Operation.payload`. | units-api only accepts the `extensions` namespace that equals the class's `programId` (`extension_namespace_not_allowed` otherwise). `asset`, `participants`, `proofs`, `snapshot`, `ctx.asset_selector` and `ctx.request_envelope` are **untrusted**. |
| 5 | **Create verbs are hard-coded.** The engine unwrap treats `mint`, `loan_originated`, `add` and `import` as create. `get_or_create_token_state` treats `mint`, `add` and `loan_originated` as create. units-api `isDomainLifecycleCreateOperation` uses `mint`, `loan_originated`, `add` and `import` (no `tokenId` required). | **Name your create op `mint`** (or `add`), or edit three places in two repos. |
| 6 | **Standards whitelist.** `supported_standards()` must contain the class's `token_classes.token_standard` **exactly**. The engine uses `Vec::contains`, which is case-sensitive. | `UNSUPPORTED_TOKEN_STANDARD`. It's async, so it only shows up in `/v1/transaction/status`. |
| 7 | **Commitment discipline.** Bump the version, set `last_tx_id`, `updated_at = ctx.timestamp` and `previous_commitment`, then call `compute_state_commitment_with_config` with the **class** config. | The **next** op on the token fails `DATA_INTEGRITY_VIOLATION` (non-retryable → DLQ). |
| 8 | **camelCase JSON.** All interface structs use `rename_all = "camelCase"`. Use the same for your extension and `data` structs. | Loan-pool is the snake_case outlier. Don't copy it. |
| 9 | **`owner` must equal the `identities[type=owner].id`, and only valid `IdentityType`s.** | On load, `owner` is re-derived from identities and unknown identity types are dropped. If the hash differs, you get `DATA_INTEGRITY_VIOLATION` on the next op. |
| 10 | **Return every mutated token in `affected_states`** with the correct `is_new` (INSERT vs optimistic UPDATE). | A wrong `is_new` gives an INSERT conflict or `ConcurrentModification` loops. |
| 11 | **Errors are `ProgramError` and terminal.** The engine never retries `EngineError::Program(_)`, even for variants where `ProgramError::is_retryable()` is true. | The error lands in `transactions.error.code` and a FAILED completion. The workflow goes ABORTED. |

### 1.2 `TokenProgram` trait (verbatim, `tokenPrograms/interface/src/traits.rs`)

```rust
#[async_trait]
pub trait TokenProgram: Send + Sync {
    fn program_id(&self) -> &str;                       // == token_class_configs.program_id
    fn name(&self) -> &str { self.program_id() }
    fn version(&self) -> &str { "1.0.0" }
    fn supported_standards(&self) -> Vec<String>;      // exact-match whitelist
    fn supported_operations(&self) -> Vec<String>;     // inner verbs; published in capability doc
    fn primitive_capabilities(&self) -> PrimitiveCapabilities { PrimitiveCapabilities::no_transfer() }
    fn supports_operation(&self, operation: &str) -> bool { ... }
    fn supports_standard(&self, standard: &str) -> bool { ... } // case-insensitive, NOT what the engine uses
    async fn execute(&self, ctx: &ExecutionContext, operation: Operation, token_state: TokenState)
        -> ProgramResult<OperationResult>;
    fn validate_operation(&self, operation: &Operation, token_state: &TokenState) -> ProgramResult<()>;
    fn plan(&self, _operation: &str) -> Option<OperationPlan> { None } // multi-step (transfer) plans
    fn compute_state_commitment(&self, state: &TokenState) -> String;   // only used for post-hook patches
}
```

The engine calls these in order: `validate_instrumented` (wraps `validate_operation`, on the persisted state), then configurable pre-hooks, then `execute_instrumented`, then persistence, then post-hooks. You get OTel metrics (`token_program.operation.*`, `token_program.validation.total`) for free.

Mandatory engine hooks always run and aren't configurable:
- **Commitment verification.** Runs before the op on every existing token and every loaded additional state.
- **Envelope verification.** Runs only for `create_incoming` and `commit_credit`.
- **Audit log.** Runs after the op and inserts into `audit_events`.

### 1.3 Capability presets (`PrimitiveCapabilities`, `interface/src/types.rs`)

| Preset | assetModel | supportedPrimitiveMethods | templates | Use for |
|---|---|---|---|---|
| `no_transfer()` (trait default) | domain_state | `[]` | no_transfer | Nothing reachable over federation. **Don't use it for a live program.** |
| `domain_lifecycle()` | domain_state | `DomainLifecycle` | domain_lifecycle | Record or state-machine tokens (loan, pool, hello-token, warranty). Non-transferable. |
| `soulbound_credential()` | soulbound_credential | `DomainLifecycle` | no_transfer | Credentials (add, revoke, suspend, resume). |
| `unique_ownership()` | unique_ownership | Lock, CommitDebit, Unlock, CreateIncoming, CommitCredit, RejectIncoming, Mint, Burn, DomainLifecycle | two_party_prepare_commit | NFTs, value "1". Same-instance transfer is `local_transfer` through domain_lifecycle. |
| `fungible_balance()` | fungible_balance | Lock, CommitDebit, Unlock, CreateIncoming, CommitCredit, RejectIncoming, Credit, Debit, Mint, Burn, Freeze, Unfreeze, Update | two_party_prepare_commit, direct_supply_change, direct_adjustment | Balances. **No DomainLifecycle**, so domain-style ops reach it only through primitive methods. |
| `proxy_ledger()` | proxy_ledger | RecordProxyEntry, Credit, Debit, Reconcile, DomainLifecycle | proxy_record | On-chain mirrors (PROXY-FT). |
| `semi_fungible_policy_bound()` | semi_fungible_policy_bound | Lock, CommitDebit, Unlock, CreateIncoming, CommitCredit, RejectIncoming, Credit | two_party_prepare_commit | Vouchers. **Missing DomainLifecycle and Mint**: this is the voucher bug (§9). |

The capability gate compares the **outer** Kafka verb after normalising it (remove `_`/`-`, lowercase) with `supportedPrimitiveMethods`. So `domain_lifecycle` needs `DomainLifecycle` and `commit_credit` needs `CommitCredit`. Reusing an existing choreography means **zero core change**. A brand-new federation verb is a gated edit across units-api (ULIP route + `is_federation_primitive`/proof binding), units-workflows (step payload) and the engine (`validate_request_envelope_shape`).

### 1.4 What the program receives (after `domain_lifecycle` unwrap)

`Operation { operation_type: <inner verb>, token_id, token_class, initiator, payload: OperationPayload::Generic(json), signature: None }`. The engine **always** sends `Generic`.

- **Create verbs** get `{tokenClass, metadata:{}, data:{}, identities:[], relationships:[], initialSupply:"1"}` plus passthrough keys: `tokenId, tokenClass, tokenClassId, tokenKind, metadata, identities, relationships, additionalStateRequirements, initialSupply, asset, primitive, participants, proofs, snapshot, extensions`.
- **Non-create verbs** get the **contents of `payload.data`**, with the same passthrough keys merged in only if absent.
- `operation.initiator` / `ctx.initiator` = the first message identity of type `operator`. For API-originated ops, that's the **caller's sha256 address hash** (`accounts.address`), not the DID. It falls back to the DID only if the account lookup misses.
- `payload.identities` is present **only if the API caller sent `identities`**. units-api doesn't add them for `domain_lifecycle`. Plan for it to be absent.
- `ctx.token_class_data()` gives you `{tokenClass: {tokenClass, tokenStandard, metadata: token_classes.metadata}, tokenClassConfig: {program_id, config: token_class_configs.config}}`.
  - Read metadata with `get_metadata::<T>("key")`.
  - Read config with `get_config_value("config.<dotted.path>")`.
  - Get the commitment config with `state_commitment_config()`.
  - Not passed: `schema`, class `identities`, `operation_overrides`, hook `config`.

---

## 2. File checklist

| # | File | Action |
|---|---|---|
| 1 | `units-token-runtime/tokenPrograms/programs/<name>/Cargo.toml` | New crate `token-program-<name>`. Deps: interface, core, async-trait, serde, serde_json, chrono, uuid, tracing. Put `tokio` in dev-deps only (keeps it WASM-friendly). |
| 2 | `.../programs/<name>/src/lib.rs` | `pub mod program; pub use program::<Name>Program;` (+ `pub mod hooks;` if you add hooks) |
| 3 | `.../programs/<name>/src/program.rs` (+ `operations/*.rs` for large programs) | `impl TokenProgram` + `#[cfg(test)]` tests |
| 4 | `units-token-runtime/tokenPrograms/Cargo.toml` | Add `"programs/<name>"` to `[workspace] members` |
| 5 | `units-token-runtime/tokenPrograms/registry/Cargo.toml` | `token-program-<name> = { path = "../programs/<name>" }` |
| 6 | `units-token-runtime/tokenPrograms/registry/src/registry.rs` | `use`, then insert in `register_default_programs()`. Hooks go in `register_default_hooks()`. |
| 7 | `units-token-runtime/scripts/seed/01-token-programs.sql`, `02-token-classes.sql` (local), and `units-api/scripts/seed/*.sql` (if the class should ship seeded) | Optional `token_programs` placeholder (the engine self-registers anyway), `token_classes` row, `token_class_configs` row |
| 8 | `units-token-runtime/CHANGELOG.md` | Entry under the next release block |
| 9 | units-api, **only if needed** | New token standard needing transfer routing (`supportsPrimitiveFederationTransfer`, `primitiveFederationTransferGate` in `src/services/token.go`), a new create verb (`isDomainLifecycleCreateOperation`), or a new saga recipe (`services/operation_planner_recipes.go`) |
| 10 | Build | `make build` / `make test` / `make lint` in units-token-runtime, then `make docker-build` (the engine links the registry statically) |

---

## 3. Worked example: `warranty-nft` (mint / claim / expire)

A product-warranty certificate. A retailer (the class issuer) mints a warranty for a customer, the customer files claims, and anyone with transact rights on the token can mark it expired once `expiresAt` has passed. It's non-transferable domain state, so it uses `PrimitiveCapabilities::domain_lifecycle()`.

Design choices that follow from the rules above:
- The customer is passed as `extensions.warranty-nft.holder`, the customer's **sha256 address hash** (the stored identity form). The program builds `identities` itself. Callers must **not** send `identities[]` on mint (canonical trap: hand-declared ids break authz later). If `holder` is absent, the minter owns it.
- Expiry is time-based. Nothing in UNITS fires on time, so `claim` checks expiry lazily and `expire` is the persisted transition, run by a sweeper or by any caller (time-based state expiry pattern: one writer of the terminal transition, conditional, monotonic, idempotent).
- Policy lives server-side: `token_classes.metadata.maxWarrantyDays` and `token_class_configs.config.warranty.maxClaims`.

### 3.1 `programs/warranty-nft/Cargo.toml`

```toml
[package]
name = "token-program-warranty-nft"
version.workspace = true
edition.workspace = true
authors.workspace = true
license.workspace = true
description = "Warranty certificate token: mint, claim, expire via domain_lifecycle"

[dependencies]
token-program-interface = { path = "../../interface" }
token-program-core = { path = "../core" }
async-trait.workspace = true
serde.workspace = true
serde_json.workspace = true
chrono.workspace = true
uuid.workspace = true
tracing.workspace = true

[dev-dependencies]
tokio = { workspace = true, features = ["rt-multi-thread", "macros"] }
```

### 3.2 `src/lib.rs`

```rust
pub mod program;
pub use program::{WarrantyNftProgram, PROGRAM_ID};
```

### 3.3 `src/program.rs`

```rust
//! warranty-nft — domain-lifecycle program: mint / claim / expire.

use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use tracing::{info, instrument};

use token_program_core::{
    compute_state_commitment, compute_state_commitment_with_config, create_state_snapshot,
};
use token_program_interface::{
    AffectedState, AuditEntry, ExecutionContext, Identity, IdentityType, Operation,
    OperationResult, PrimitiveCapabilities, PrimitivePayload, ProgramError, ProgramResult,
    StateSnapshot, TokenProgram, TokenState, TokenStatus,
};

pub const PROGRAM_ID: &str = "warranty-nft";
const STANDARD: &str = "UNITS-WARRANTY";
const DEFAULT_MAX_DAYS: i64 = 3650;
const DEFAULT_MAX_CLAIMS: u32 = 1;

// ---------- payload shapes (extensions.warranty-nft) ----------
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MintExt {
    product_sku: String,
    serial_number: String,
    expires_at: DateTime<Utc>,
    /// sha256(lower(trim(address))) of the customer; defaults to the minter.
    #[serde(default)]
    holder: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaimExt {
    claim_ref: String,
    #[serde(default)]
    description: Option<String>,
}

// ---------- shape stored in token_state.data ----------
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WarrantyData {
    product_sku: String,
    serial_number: String,
    expires_at: DateTime<Utc>,
    #[serde(default)]
    claims: Vec<serde_json::Value>,
    /// "active" | "claimed" | "expired"
    status: String,
}

#[derive(Debug, Clone, Default)]
pub struct WarrantyNftProgram;

impl WarrantyNftProgram {
    pub fn new() -> Self {
        Self
    }
}

fn is_address_hash(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn data_of(state: &TokenState) -> ProgramResult<WarrantyData> {
    serde_json::from_value(state.data.clone())
        .map_err(|e| ProgramError::InternalError(format!("corrupt warranty data: {e}")))
}

fn max_days(ctx: &ExecutionContext) -> i64 {
    ctx.token_class_data()
        .and_then(|d| d.get_metadata::<i64>("maxWarrantyDays"))
        .unwrap_or(DEFAULT_MAX_DAYS)
}

fn max_claims(ctx: &ExecutionContext) -> u32 {
    ctx.token_class_data()
        .and_then(|d| d.get_config_value("config.warranty.maxClaims"))
        .and_then(|v| v.as_u64())
        .map(|v| v as u32)
        .unwrap_or(DEFAULT_MAX_CLAIMS)
}

fn identity(id: &str, t: IdentityType) -> Identity {
    Identity { id: id.to_string(), name: None, identity_type: t, roles: None }
}

#[async_trait]
impl TokenProgram for WarrantyNftProgram {
    fn program_id(&self) -> &str { PROGRAM_ID }
    fn name(&self) -> &str { "Warranty NFT Program" }
    fn version(&self) -> &str { "1.0.0" }
    fn supported_standards(&self) -> Vec<String> { vec![STANDARD.to_string()] }
    fn supported_operations(&self) -> Vec<String> {
        vec!["mint".into(), "claim".into(), "expire".into()]
    }
    fn primitive_capabilities(&self) -> PrimitiveCapabilities {
        PrimitiveCapabilities::domain_lifecycle() // outer Kafka verb = domain_lifecycle
    }

    fn validate_operation(&self, op: &Operation, s: &TokenState) -> ProgramResult<()> {
        if !self.supports_operation(&op.operation_type) {
            return Err(ProgramError::UnsupportedOperation(format!(
                "warranty-nft does not support '{}'. Supported: mint, claim, expire",
                op.operation_type
            )));
        }
        match op.operation_type.as_str() {
            "mint" if s.state_version > 0 => {
                Err(ProgramError::ValidationFailed("warranty already exists".into()))
            }
            "claim" | "expire" if s.state_version == 0 => {
                Err(ProgramError::TokenNotFound("warranty does not exist".into()))
            }
            "claim" | "expire" if s.state.status != TokenStatus::Active => {
                Err(ProgramError::InvalidTokenStatus {
                    status: s.state.status.to_string(),
                    operation: op.operation_type.clone(),
                })
            }
            _ => Ok(()),
        }
    }

    #[instrument(skip(self, ctx, token_state), fields(tx_id = %ctx.tx_id, op = %operation.operation_type))]
    async fn execute(
        &self,
        ctx: &ExecutionContext,
        operation: Operation,
        token_state: TokenState,
    ) -> ProgramResult<OperationResult> {
        // Engine already called validate_operation; repeat so direct (test) callers are safe.
        self.validate_operation(&operation, &token_state)?;
        let state_before: StateSnapshot = create_state_snapshot(&token_state);
        let payload = PrimitivePayload::from_operation(&operation)?;
        let is_new = token_state.state_version == 0;
        let mut s = token_state;

        match operation.operation_type.as_str() {
            "mint" => {
                let ext: MintExt = payload.extension(PROGRAM_ID)?.ok_or_else(|| {
                    ProgramError::InvalidPayload("extensions.warranty-nft required".into())
                })?;
                if ext.expires_at <= ctx.timestamp {
                    return Err(ProgramError::ValidationFailed("expiresAt must be in the future".into()));
                }
                let limit = max_days(ctx);
                if ext.expires_at > ctx.timestamp + Duration::days(limit) {
                    return Err(ProgramError::ValidationFailed(format!(
                        "warranty longer than {limit} days"
                    )));
                }
                let issuer = operation.initiator.trim().to_string();
                if issuer.is_empty() {
                    return Err(ProgramError::Unauthorized("no initiator".into()));
                }
                let owner = match ext.holder.as_deref().map(str::trim) {
                    Some(h) if !h.is_empty() => {
                        let h = h.to_ascii_lowercase();
                        if !is_address_hash(&h) {
                            return Err(ProgramError::InvalidPayload(
                                "holder must be the sha256 hex hash of the holder's address".into(),
                            ));
                        }
                        h
                    }
                    _ => issuer.clone(),
                };
                // Program owns the identity set: exactly one owner, plus the issuer.
                // owner MUST equal identities[type=owner].id (re-derived on load).
                s.owner = owner.clone();
                s.identities = vec![identity(&owner, IdentityType::Owner)];
                if issuer != owner {
                    s.identities.push(identity(&issuer, IdentityType::Issuer));
                }
                s.data = serde_json::to_value(WarrantyData {
                    product_sku: ext.product_sku,
                    serial_number: ext.serial_number,
                    expires_at: ext.expires_at,
                    claims: vec![],
                    status: "active".into(),
                })?;
                s.state.status = TokenStatus::Active;
                s.state.effective_from = Some(ctx.timestamp);
                s.state.effective_until = Some(ext.expires_at);
            }
            "claim" => {
                let ext: ClaimExt = payload.extension(PROGRAM_ID)?.ok_or_else(|| {
                    ProgramError::InvalidPayload("extensions.warranty-nft.claimRef required".into())
                })?;
                let mut d = data_of(&s)?;
                if ctx.timestamp >= d.expires_at {
                    return Err(ProgramError::ValidationFailed(
                        "warranty expired; submit operation 'expire'".into(),
                    ));
                }
                if d.claims.iter().any(|c| c["claimRef"] == ext.claim_ref.as_str()) {
                    return Err(ProgramError::ClaimAlreadyExists(ext.claim_ref));
                }
                d.claims.push(serde_json::json!({
                    "claimRef": ext.claim_ref,
                    "description": ext.description,
                    "at": ctx.timestamp,
                    "by": operation.initiator,
                }));
                if d.claims.len() as u32 >= max_claims(ctx) {
                    d.status = "claimed".into();
                    s.state.status = TokenStatus::Redeemed; // terminal
                }
                s.data = serde_json::to_value(d)?;
            }
            "expire" => {
                let mut d = data_of(&s)?;
                if ctx.timestamp < d.expires_at {
                    return Err(ProgramError::ValidationFailed(format!(
                        "warranty not expired until {}", d.expires_at
                    )));
                }
                d.status = "expired".into();
                s.data = serde_json::to_value(d)?;
                s.state.status = TokenStatus::Expired; // terminal, monotonic
            }
            other => return Err(ProgramError::UnsupportedOperation(other.into())),
        }

        // ---- commitment chaining (mandatory, exactly this shape) ----
        s.state_version += 1;
        s.last_tx_id = Some(ctx.tx_id.clone());
        s.updated_at = ctx.timestamp;
        s.previous_commitment = state_before.state_commitment.clone();
        let cfg = ctx
            .token_class_data()
            .map(|d| d.state_commitment_config())
            .unwrap_or_default();
        s.state_commitment = compute_state_commitment_with_config(&s, &cfg);

        let state_after = create_state_snapshot(&s);
        info!(token_id = %s.token_id, "warranty_operation_completed");
        Ok(OperationResult {
            new_state: s.clone(),
            state_before: state_before.clone(),
            state_after: state_after.clone(),
            affected_states: vec![AffectedState {
                token_state: s.clone(),
                state_before: state_before.clone(),
                is_new,
                entry_type: None,
            }],
            audit_entry: AuditEntry {
                event_type: format!("WARRANTY_{}", operation.operation_type.to_uppercase()),
                entity_type: "token".into(),
                entity_id: s.token_id.to_string(),
                actor: operation.initiator.clone(),
                action: operation.operation_type.clone(),
                changes: serde_json::json!({ "before": state_before, "after": state_after }),
            },
            units: None,
            participants: vec![],
        })
    }

    fn compute_state_commitment(&self, state: &TokenState) -> String {
        compute_state_commitment(state)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use token_program_interface::{OperationPayload, TokenClassData, TraceContext};
    use uuid::Uuid;

    const ISSUER: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const HOLDER: &str = "2222222222222222222222222222222222222222222222222222222222222222";

    fn ctx_at(ts: &str) -> ExecutionContext {
        let mut c = ExecutionContext::new(
            Uuid::now_v7().to_string(), "corr".into(), ISSUER.into(), TraceContext::default(),
        )
        .with_token_class_data(TokenClassData::new(
            serde_json::json!({"tokenClass":"WARRANTY","tokenStandard":STANDARD,
                               "metadata":{"fungible":false,"maxWarrantyDays":1825}}),
            serde_json::json!({"program_id":PROGRAM_ID,
                               "config":{"stateCommitmentAlgorithm":"sha256","warranty":{"maxClaims":2}}}),
        ));
        c.timestamp = ts.parse().unwrap();
        c
    }
    fn op(kind: &str, initiator: &str, payload: serde_json::Value) -> Operation {
        Operation {
            operation_type: kind.into(), token_id: None, token_class: "WARRANTY".into(),
            initiator: initiator.into(), payload: OperationPayload::Generic(payload), signature: None,
        }
    }
    fn mint_payload(holder: Option<&str>) -> serde_json::Value {
        let mut ext = serde_json::json!({"productSku":"TV-55","serialNumber":"SN1",
                                         "expiresAt":"2027-01-01T00:00:00Z"});
        if let Some(h) = holder { ext["holder"] = serde_json::json!(h); }
        serde_json::json!({"tokenClass":"WARRANTY","extensions":{"warranty-nft": ext}})
    }
    async fn minted(holder: Option<&str>) -> TokenState {
        let s0 = TokenState::new_for_mint("WARRANTY", Uuid::now_v7(), STANDARD);
        WarrantyNftProgram::new()
            .execute(&ctx_at("2026-10-03T10:00:00Z"), op("mint", ISSUER, mint_payload(holder)), s0)
            .await.unwrap().new_state
    }

    #[test]
    fn capability_is_domain_lifecycle() {
        let caps = WarrantyNftProgram::new().primitive_capabilities();
        assert_eq!(caps.supported_primitive_methods, vec!["DomainLifecycle"]);
    }

    #[tokio::test]
    async fn mint_defaults_owner_to_initiator() {
        let s = minted(None).await;
        assert_eq!(s.owner, ISSUER);
        assert_eq!(s.identities.len(), 1);
        assert_eq!(s.identities[0].identity_type, IdentityType::Owner);
        assert_eq!(s.state_version, 1);
    }

    #[tokio::test]
    async fn mint_for_holder_stamps_owner_and_issuer() {
        let s = minted(Some(HOLDER)).await;
        assert_eq!(s.owner, HOLDER);
        // owner must equal identities[type=owner] or the next op fails DATA_INTEGRITY_VIOLATION
        let owner_id = s.identities.iter().find(|i| i.identity_type == IdentityType::Owner).unwrap();
        assert_eq!(owner_id.id, s.owner);
        assert!(s.identities.iter().any(|i| i.identity_type == IdentityType::Issuer && i.id == ISSUER));
    }

    #[tokio::test]
    async fn commitment_is_reproducible_from_class_config() {
        let s = minted(Some(HOLDER)).await;
        let cfg = ctx_at("2026-10-03T10:00:00Z").token_class_data().unwrap().state_commitment_config();
        assert_eq!(compute_state_commitment_with_config(&s, &cfg), s.state_commitment);
    }

    #[tokio::test]
    async fn claim_chains_commitment_and_hits_max_claims() {
        let p = WarrantyNftProgram::new();
        let s1 = minted(Some(HOLDER)).await;
        let claim = |r: &str| serde_json::json!({"extensions":{"warranty-nft":{"claimRef": r}}});
        let r2 = p.execute(&ctx_at("2026-11-01T00:00:00Z"), op("claim", HOLDER, claim("C-1")), s1.clone())
            .await.unwrap();
        assert_eq!(r2.new_state.previous_commitment, s1.state_commitment);
        assert_eq!(r2.new_state.state.status, TokenStatus::Active); // 1 of 2
        assert!(!r2.affected_states[0].is_new);
        let r3 = p.execute(&ctx_at("2026-11-02T00:00:00Z"), op("claim", HOLDER, claim("C-2")), r2.new_state)
            .await.unwrap();
        assert_eq!(r3.new_state.state.status, TokenStatus::Redeemed);
        assert_eq!(r3.new_state.state_version, 3);
    }

    #[tokio::test]
    async fn duplicate_claim_ref_rejected() {
        let p = WarrantyNftProgram::new();
        let s1 = minted(None).await;
        let claim = serde_json::json!({"extensions":{"warranty-nft":{"claimRef":"C-1"}}});
        let s2 = p.execute(&ctx_at("2026-11-01T00:00:00Z"), op("claim", ISSUER, claim.clone()), s1)
            .await.unwrap().new_state;
        let e = p.execute(&ctx_at("2026-11-02T00:00:00Z"), op("claim", ISSUER, claim), s2).await.unwrap_err();
        assert!(matches!(e, ProgramError::ClaimAlreadyExists(_)));
    }

    #[tokio::test]
    async fn claim_after_expiry_fails_and_expire_succeeds() {
        let p = WarrantyNftProgram::new();
        let s1 = minted(None).await;
        let late = ctx_at("2027-02-01T00:00:00Z");
        let e = p.execute(&late, op("claim", ISSUER,
            serde_json::json!({"extensions":{"warranty-nft":{"claimRef":"C-9"}}})), s1.clone()).await.unwrap_err();
        assert!(matches!(e, ProgramError::ValidationFailed(_)));
        let r = p.execute(&late, op("expire", ISSUER, serde_json::json!({})), s1).await.unwrap();
        assert_eq!(r.new_state.state.status, TokenStatus::Expired);
    }

    #[tokio::test]
    async fn expire_before_expiry_fails() {
        let p = WarrantyNftProgram::new();
        let s1 = minted(None).await;
        let e = p.execute(&ctx_at("2026-12-01T00:00:00Z"), op("expire", ISSUER, serde_json::json!({})), s1)
            .await.unwrap_err();
        assert!(matches!(e, ProgramError::ValidationFailed(_)));
    }

    #[tokio::test]
    async fn non_create_on_missing_token_fails() {
        let s0 = TokenState::new_for_mint("WARRANTY", Uuid::now_v7(), STANDARD);
        let e = WarrantyNftProgram::new()
            .execute(&ctx_at("2026-10-03T10:00:00Z"), op("claim", HOLDER, serde_json::json!({})), s0)
            .await.unwrap_err();
        assert!(matches!(e, ProgramError::TokenNotFound(_)));
    }

    #[tokio::test]
    async fn bad_holder_rejected_and_policy_enforced() {
        let p = WarrantyNftProgram::new();
        let s0 = TokenState::new_for_mint("WARRANTY", Uuid::now_v7(), STANDARD);
        let e = p.execute(&ctx_at("2026-10-03T10:00:00Z"),
            op("mint", ISSUER, mint_payload(Some("bob@example.com"))), s0.clone()).await.unwrap_err();
        assert!(matches!(e, ProgramError::InvalidPayload(_)));
        let mut far = mint_payload(None);
        far["extensions"]["warranty-nft"]["expiresAt"] = serde_json::json!("2040-01-01T00:00:00Z");
        let e = p.execute(&ctx_at("2026-10-03T10:00:00Z"), op("mint", ISSUER, far), s0).await.unwrap_err();
        assert!(matches!(e, ProgramError::ValidationFailed(_))); // > maxWarrantyDays (1825)
    }
}
```

Notes on the code:
- `ctx.timestamp` is the Kafka message timestamp in production and `Utc::now()` from `ExecutionContext::new` in tests. Tests overwrite it so they're deterministic.
- The program **ignores** `payload.identities` on purpose. If you want to accept caller identities, validate every `type` against `IdentityType` and every `id` as a 64-hex hash, and keep exactly one owner.
- There's no in-program authorization. units-api's OPA layer decides who may call `claim`/`expire` (§4.4). If an invariant must hold no matter who calls, put it in `validate_operation`/`execute` and check `operation.initiator` against the token's identities.

### 3.4 Workspace + registry edits

```toml
# units-token-runtime/tokenPrograms/Cargo.toml
[workspace]
members = [ ..., "programs/hello-token", "programs/warranty-nft" ]

# units-token-runtime/tokenPrograms/registry/Cargo.toml  [dependencies]
token-program-warranty-nft = { path = "../programs/warranty-nft" }
```

```rust
// units-token-runtime/tokenPrograms/registry/src/registry.rs
use token_program_warranty_nft::WarrantyNftProgram;

// inside fn register_default_programs(&mut self), mirroring the existing blocks:
let warranty_program = Arc::new(WarrantyNftProgram::new());
let warranty_program_id = warranty_program.program_id().to_string();
self.programs.insert(warranty_program_id.clone(), warranty_program);
debug!(program_id = %warranty_program_id, "default_program_registered");
```

Build and verify:

```bash
cd units-token-runtime
(cd tokenPrograms && cargo test -p token-program-warranty-nft && cargo clippy -p token-program-warranty-nft --all-targets)
make test            # programs + engine
make lint            # cargo clippy --all-targets --all-features (both workspaces)
make docker-build    # multi-arch engine image
```

---

## 4. How the system learns about the program

### 4.1 Engine self-registration into `token_programs` (ADR-0001)

At every boot the engine calls `TokenProgramRepository::sync_registry` (`tokenEngine/src/db/repositories/token_program.rs`) and upserts each compiled-in program with `ON CONFLICT (program_id) DO UPDATE`:
- `name`, `version`, `supported_standards` and `supported_operations` are **replaced** with the code values.
- `config = existing || {"primitiveCapabilities": <caps>, "plans": {op: OperationPlan for each op where plan(op) is Some}, "selfRegistered": true}`.
- New rows get description `"Self-registered by token-engine"` and status `active`. `description`, `identities` and `status` stay operator-owned.
- A failure is logged, not fatal.

```sql
SELECT program_id, version, supported_standards, supported_operations,
       config->'primitiveCapabilities' AS caps, config->'selfRegistered' AS self_reg
FROM token_programs WHERE program_id = 'warranty-nft';
```

### 4.2 Capability publish to the registry

units-api's `CapabilityPublisher` builds the instance **capability document** from active `token_programs` rows. It needs at least one `selfRegistered` row, or publishing fails. It publishes the signed document to the central registry. It publishes at units-api **boot**, on `POST /v1/registry/capability/publish` (api id `api.registry.capability.publish`, needs scope `internal:manage`), or on SIGHUP. There's no periodic loop.

`StartDomainLifecycle` reads the **registry-published** document of the local instance, through a TTL-cached resolver, not the local table. So after deploying a new engine you must:
1. Let the engine boot (self-registration).
2. Re-publish from units-api (restart, SIGHUP or `/v1/registry/capability/publish`).
3. Wait out the resolver cache TTL.

Until then, ops fail synchronously with `400 primitive_capability_missing` (program not in the document) or `operation_not_supported` (inner verb not in `supportedOperations`).

### 4.3 How units-api routes ops (`src/services/token.go`, `src/services/federation.go`)

| API call | Path in units-api | What reaches your program |
|---|---|---|
| `POST /v1/token/mint {tokenClass, initialSupply, metadata?, data?, extensions?}` | `MintToken`: class-issuer check (only if the class has identities), then `StartDomainLifecycle(Operation:"mint")` | inner verb `mint`, create-shaped payload, `extensions.<programId>` passed through |
| `POST /v1/token/transact {operation:"<verb>", tokenId, data?, metadata?, extensions?, value?}` where verb ≠ `transfer` | `TransactToken` → OPA authz (`update` → `manage`, else `transact`) → `StartDomainLifecycle(Operation:<verb>, Data, Metadata, Extensions, Value)` | inner verb, payload = `data` contents + `tokenId`, `extensions`, `metadata`... |
| `transact` with `operation:"transfer"` | `supportsPrimitiveFederationTransfer(tokenStandard)` → `StartTransfer` (two_party_prepare_commit / proxy_record), or same-instance NFT `local_transfer` | primitive verbs (`lock`, `create_incoming`, ...). **Unknown standards are rejected** with `capability_gate: two_party_prepare_commit_not_declared_for_token_standard` |
| `POST /v1/token/add` | credential (`add`), proxy (`import`/`reconcile`) | — |

`StartDomainLifecycle` checks the following in order:
1. DID and op present; `tokenId` present for non-create ops (`token_id_required_for_domain_lifecycle_update`).
2. Sender home is local (else `409` FORWARD).
3. Local capability document has the program (`primitive_capability_missing`) and the op (`operation_not_supported`).
4. `extensions` keys equal `programId` (`extension_namespace_not_allowed`).

It then mints a UUIDv7 `txnId`, builds a `domain_lifecycle@2.0` plan (one `DomainLifecycle` step), inserts the `transactions` row (`status:"pending"`, `status_v2:"submitted"`, `plan_data`), and starts Restate `primitive-operation` with workflow id = txnId. The ULIP `DomainLifecycle` handler copies `operation, data, metadata, identities, relationships, additionalStateRequirements` and the reserved namespaces into the Kafka payload. It stamps message identities `[{owner: callerHash}, {operator: callerHash}]`.

### 4.4 Authorization you get for free (and don't)

- **Mint**: `authz.IsIdentityRole(class.identities, caller, "issuer")` when the class has identities. A class whose stored identities are empty or null has no issuer restriction. `/tokenclass/register` never stores `[]`; it stamps the caller as owner and issuer. Only seeds or `/tokenclass/update` can produce such a class, so always keep issuers listed.
- **Transact** (OPA `src/authz/policies/rbac.rego`):
  - The owner can do anything.
  - Any identity may **view**.
  - Transact/manage need a token identity of type `transact`/`manage` (legacy) or a delegation (`tokens:id:<uuid>`, `tokens:tokenclass:<CLASS>`, ...).
  - An `issuer` identity on the token does **not** grant transact. `class_manager_operations` from class metadata only feeds OPA in the delegation path today.
  - So in the warranty example, the retailer can't `expire` a customer's warranty unless the customer delegates `transact`. A sweeper must run as an account holding a delegation.
- Don't stamp `transact`/`manage` identity types from a program. OPA honours them, but the engine's `IdentityType` enum doesn't, so they're dropped on load (commitment mismatch) or fail deserialisation (`INVALID_PAYLOAD unknown variant`).

---

## 5. Seed the class and config

### 5.1 Through the API (preferred; works on any instance)

Envelope as in `api-reference.md`. Use the operator account's session (it becomes class owner and issuer).

```jsonc
// POST /v1/tokenclass/register   (context.id "api.tokenclass.register")
{ "payload": {
    "tokenClass": "WARRANTY",
    "tokenStandard": "UNITS-WARRANTY",          // must be in supported_standards() EXACTLY
    "name": "Product Warranty",
    "description": "Warranty certificate (warranty-nft program)",
    "schema": { "type": "object" },             // documentation only, not enforced
    "metadata": {
      "fungible": false,                         // REQUIRED for one-token-per-mint semantics (see §9)
      "transferable": false,
      "maxWarrantyDays": 1825                    // program policy, read via get_metadata
    }
    // omit "identities": the registering caller is stamped owner+issuer
} }
// → response.id = tokenClassId (uuid)

// POST /v1/tokenclassconfig/register   (context.id "api.tokenclassconfig.register")
{ "payload": {
    "tokenClass": "WARRANTY",
    "tokenClassId": "<uuid from above>",
    "programId": "warranty-nft",                 // NOT validated against token_programs: typos fail later
    "preHooks":  [ { "hookId": "logging", "priority": 100, "enabled": true } ],
    "postHooks": [ { "hookId": "logging", "priority": 100, "enabled": true } ],
    "config": {
      "stateCommitmentAlgorithm": "sha256",      // or "blake3"; empty stateCommitmentFields = all fields
      "warranty": { "maxClaims": 1 }             // program config, read via get_config_value("config.warranty.maxClaims")
    }
} }
```

Neither register endpoint validates `tokenStandard` or `programId`. Mistakes only surface asynchronously (`UNSUPPORTED_TOKEN_STANDARD`, `PROGRAM_NOT_FOUND`) or as `primitive_capability_missing`.

### 5.2 Through SQL (local dev seeds)

```sql
-- optional: the engine self-registers on boot anyway
INSERT INTO token_programs (id, program_id, name, description, version, supported_standards, supported_operations, config, status)
VALUES ('01938000-0000-7000-8000-0000000000a1','warranty-nft','Warranty NFT Program','Warranty certificates','1.0.0',
        '["UNITS-WARRANTY"]','["mint","claim","expire"]','{}','active')
ON CONFLICT (program_id) DO NOTHING;

INSERT INTO token_classes (id, token_class, token_standard, name, description, schema, identities, metadata, status)
VALUES ('01938000-0000-7000-8000-0000000000b1','WARRANTY','UNITS-WARRANTY','Product Warranty','Warranty NFT','{}',
        '[{"id":"<sha256 of issuer address>","type":"issuer"},{"id":"<same>","type":"owner"}]',
        '{"fungible":false,"transferable":false,"maxWarrantyDays":1825}','active');

INSERT INTO token_class_configs (id, token_class, token_class_id, program_id, pre_hooks, post_hooks, operation_overrides, config, status)
VALUES ('01938000-0000-7000-8000-0000000000c1','WARRANTY','01938000-0000-7000-8000-0000000000b1','warranty-nft',
        '[{"hookId":"logging","priority":100,"enabled":true}]',
        '[{"hookId":"logging","priority":100,"enabled":true}]',
        '{}', '{"stateCommitmentAlgorithm":"sha256","warranty":{"maxClaims":1}}', 'active');
```

---

## 6. End-to-end test through the API (local stack)

Prereqs: the local stack with the engine image you just built, a units-api capability re-publish (§4.2), and a working `primitive-operation` workflow (see `local-development.md` §4, "workflow-orchestrator runs only profile-update"). Use two accounts: the operator/retailer and the customer. Locally the mock OTP is `123456`.

1. Log in as the retailer: `POST /v1/account/login {username}`, then `{username, otp:"123456"}` → `accessToken`.
2. Register the class and config (§5.1) with the retailer session.
3. Compute the customer hash: `printf '%s' 'bob' | tr 'A-Z' 'a-z' | shasum -a 256` (sha256 hex of the trimmed, lowercased address, with no `0x`).
4. Mint (retailer session):
   ```jsonc
   // POST /v1/token/mint   context.id "api.token.mint", context.valueFormat "raw"
   { "payload": { "tokenClass": "WARRANTY", "initialSupply": "1",
       "metadata": { "name": "TV-55 warranty" },
       "extensions": { "warranty-nft": { "productSku": "TV-55", "serialNumber": "SN1",
                        "expiresAt": "2027-01-01T00:00:00Z", "holder": "<bob sha256>" } } } }
   // → { txId, status:"submitted" }   (no tokenId)
   ```
5. Poll `POST /v1/transaction/status {txId}` until it's `completed` or `failed`. Then `POST /v1/transaction/get {txId}` → `response.metadata.token_id` / `metadata.affectedTokenIds[0]`.
6. Claim (customer session, signed; enforcement is environment-dependent, so always sign):
   ```jsonc
   // POST /v1/token/transact   context.id "api.token.transact"
   { "payload": { "operation": "claim", "tokenId": "<id>",
       "extensions": { "warranty-nft": { "claimRef": "C-9", "description": "screen dead" } } },
     "signature": { "keyId": "<registered ed25519 key id>", "jws": "<b64 Ed25519 over JCS(payload)>" } }
   ```
7. Verify in SQL (`local-development.md` §6 has the full debugging queries):
   ```sql
   SELECT status, error, metadata->'affectedTokenIds' FROM transactions WHERE id = '<txId>';
   SELECT operation, participants FROM token_transactions WHERE tx_id = '<txId>';          -- operation='claim'
   SELECT state_version, state_commitment, previous_commitment FROM state_history
     WHERE token_id = '<id>' ORDER BY state_version;                                        -- chain intact
   SELECT engine_status, completion_status, completion_error FROM primitive_ops WHERE txn_id = '<txId>';
   ```

What the engine receives for the claim (for reading DLQ or engine logs):

```json
{ "txId": "0196...d2", "operation": "domain_lifecycle", "tokenClass": "WARRANTY", "tokenId": "<id>",
  "opSeq": 1, "callerInstance": "<LOCAL_INSTANCE_ID>", "calleeInstance": "<LOCAL_INSTANCE_ID>",
  "workflowId": "0196...d2", "requestEnvelope": "<base64 ULIP envelope, context.method=DomainLifecycle>",
  "completionTarget": "http://.../v1/internal/primitives/complete",
  "payload": { "operation": "claim", "tokenId": "<id>", "data": {},
               "extensions": { "warranty-nft": { "claimRef": "C-9", "description": "screen dead" } },
               "primitive": { "method": "DomainLifecycle", "opSeq": 1, "templateName": "domain_lifecycle", "templateVersion": "2.0", "operationName": "claim" } },
  "correlationId": "0196...d2:1", "timestamp": "2026-11-01T00:00:00Z",
  "identities": [ { "id": "<bob sha256>", "type": "owner" }, { "id": "<bob sha256>", "type": "operator" } ] }
```

Engine path: capability gate (`domain_lifecycle` ∈ DomainLifecycle) → unwrap (non-create: `data` + passthrough `tokenId`, `extensions`) → load token by id → commitment verify → `validate_operation("claim")` → pre-hooks → `execute` → one sql tx (tokens UPDATE v1→v2, token_transactions `operation='claim'`, state_history v2, `primitive_ops.engine_status='executed'`) → post-hooks → audit `WARRANTY_CLAIM` (the program's `event_type`) → `transactions.status='completed'` → signed completion POST.

---

## 7. Writing a new hook

Hooks are cross-cutting checks that a class switches on in `token_class_configs.pre_hooks/post_hooks`. Prefer program logic for invariants that must always hold. Use hooks for optional, per-class policy.

```rust
// programs/warranty-nft/src/hooks/claim_window.rs
use async_trait::async_trait;
use token_program_interface::{ExecutionContext, Hook, HookOutput, HookResult, Operation, ProgramError, TokenState};

/// Pre-hook: reject claims filed within `metadata.claimCoolingDays` of mint.
#[derive(Debug, Clone, Default)]
pub struct ClaimWindowHook;

#[async_trait]
impl Hook for ClaimWindowHook {
    fn hook_id(&self) -> &str { "warranty-claim-window" }       // kebab-case; this is the config hookId
    fn name(&self) -> &str { "Warranty claim cooling-off window" }

    async fn pre_execute(&self, ctx: &ExecutionContext, op: &Operation, s: &TokenState) -> HookResult {
        if op.operation_type != "claim" { return Ok(HookOutput::ok()); } // already the inner verb
        let days: i64 = match ctx.token_class_data().and_then(|d| d.get_metadata::<i64>("claimCoolingDays")) {
            Some(d) if d > 0 => d,
            _ => return Ok(HookOutput::ok()),                           // unconfigured => pass
        };
        let from = s.state.effective_from.unwrap_or(s.created_at);
        if ctx.timestamp < from + chrono::Duration::days(days) {
            return Err(ProgramError::ValidationFailed(format!("claims open {days} days after purchase")));
        }
        Ok(HookOutput::ok())
    }

    async fn post_execute(&self, _: &ExecutionContext, _: &Operation, _: &TokenState, _: &TokenState) -> HookResult {
        Ok(HookOutput::ok())
    }
}
```

Register it in `registry.rs` → `register_default_hooks()`:

```rust
use token_program_warranty_nft::hooks::ClaimWindowHook;
let claim_window = Arc::new(ClaimWindowHook::default());
self.hooks.insert(claim_window.hook_id().to_string(), claim_window);
```

Enable it per class: `"preHooks": [{"hookId":"warranty-claim-window","priority":20,"enabled":true,"operations":["claim"]}]`.

Hook semantics (`tokenEngine/src/engine/hook_runner.rs`):
- Sorted by **config** `priority` ascending. `Hook::priority()` is ignored.
- The `operations` filter is normalised (camel/Pascal/kebab → snake, lowercase) and matched against the **inner** verb.
- An **unknown `hookId` is silently skipped** with a warn log. A typo means no enforcement.
- **`HookConfig.config` is never passed to the hook.** Read policy from class metadata or config through `ctx.token_class_data()`.
- Pre-hook `Err`, `Fail` or `Skip` → `HOOK_FAILED` (user codes `MIN_BALANCE_VIOLATED`/`MAX_SUPPLY_EXCEEDED` only for those two ids). `Skip` blocks too. Pre-hook `modified_state` is ignored.
- Post-hooks run **after commit**. Errors are only logged.
  - `with_modified_state` patches only `relationships` + commitment, with no `state_history` row and the program's default commitment config. That breaks the chain. **Don't use it.**
  - `with_metadata({"secondaryOperations":[...]})` republishes best-effort follow-up ops with `opSeq 0`. They have no dedup and no completion.

Existing hook ids: `logging`, `validation` (authz for transfer/burn only, status for unfreeze), `max-supply` (mint; `metadata.maxSupply`), `min-balance` (transfer/burn/lock/debit; `metadata.minBalance`; fails if `value` absent), `credential-verification` (voucher issue).

---

## 8. Adding a config key

| Where | When | How to read | Notes |
|---|---|---|---|
| `token_classes.metadata.<key>` | Policy that's part of the instrument definition (limits, decimals, flags) | `ctx.token_class_data()?.get_metadata::<T>("key")` | Also visible to integrators via `/v1/tokenclass/get`. The engine itself reads only `fungible`. units-api reads `decimals` (display ↔ raw), `contractIds`, `class_manager_operations` (delegation path only). |
| `token_class_configs.config.<key>` | Engine or program behaviour per class | `get_config_value("config.<dotted.path>")` | The engine consumes `stateCommitmentFields`, `stateCommitmentAlgorithm` and `additionalStateRequirements`. Everything else is free-form. Unknown keys are ignored, so typos are silent. |
| Process env (e.g. `StablesConfig::from_env()`) | Endpoints and secrets shared by all classes | constructor in `register_default_programs` | Needs engine deployment config. Avoid for per-class policy. |

Checklist for a new key:
1. Namespace it (`config.<program>.<key>`) so it can't collide with engine keys.
2. Provide a safe default when it's absent and unit-test both paths (build `TokenClassData::new(...)` in tests as in §3.3).
3. Document it in the program crate docs and in `token-classes.md` / `token-programs.md`.
4. Update seeds and example payloads.
5. If it affects commitment (new `stateCommitmentFields` entries or the algorithm): the engine snapshots the config used into `state_history.commitment_config` and verifies old states with their historical config. Changing it for a live class is safe for old versions but **ask first** (backward compat).
6. Don't expect `operationOverrides` to enforce anything. It's stored but never read by the engine (§9).

---

## 9. Variants

### 9.1 Fungible-like program (value-bearing, transferable)
- Capabilities `fungible_balance()`. Implement the primitive verbs `lock`, `unlock`, `commit_debit`, `create_incoming`, `commit_credit`, `reject_incoming`, `credit`, `debit` (+ `mint`, `burn`, `freeze`, `unfreeze`, `update`). Reuse `token_program_core::{execute_primitive, FungibleBalanceModel}` and `balance_helpers`. Use `PrimitivePayload::require_value_conservation(locked, credited)`. Gate value ops on `TokenStatus::Active`.
- `plan("transfer")` → two phases. prepare: `lock`@source → `create_incoming`@destination, on_failure `reject_incoming`/`unlock`. commit: `commit_debit`@source → `commit_credit`@destination. This lands in `token_programs.config.plans` and units-api prefers it over the built-in recipe.
- **units-api change required for a new standard.** `transact transfer` only routes standards listed in `supportsPrimitiveFederationTransfer` (`UNITS-FT, ERC-20, ERC-3643, REFERENCE-FT, UNITS-NFT, ERC-721, REFERENCE-NFT, UNITS-SFT, PURPOSE-BOUND-VOUCHER, PROXY-FT, STABLES`). Either reuse one of those standards (and whitelist it in your program) or add yours to that switch and to `primitiveFederationTransferGate`.
- `metadata.fungible` true (the default) → create verbs **merge into the owner's existing token** of the class (oldest row, `find_by_owner_and_class`). The create payload must carry an `issuer` or `owner` identity, or you get `Mint payload must include an Issuer or Owner identity`. There's no batch identity for fungibles.
- Commitment: `state.balance` is authoritative and hashed. `incoming[]`/`locks[]` are part of `state`.

### 9.2 Unique-ownership NFT with transfer
- `unique_ownership()` + `NftBalanceModel`. Value must be "1" (`require_value_one`). Cross-instance transfer uses the 2PC primitives. Same-instance transfer is routed by units-api as `domain_lifecycle` inner verb **`local_transfer`** with `data {recipient, recipientDid, value:"1"}`. Implement it as an ownership flip that rewrites the owner identity and `owner`.

### 9.3 Proxy program (mirror of an on-chain asset)
- `proxy_ledger()`; standard `PROXY-FT` (or add yours to `isProxyTokenStandard` and the related switches in units-api). Ops `import` (create), `reconcile`, `transfer`, `sign`, plus primitives `record_proxy_entry`, `debit`, `credit`.
- Chain I/O goes through the **adapter orchestrator** (`ADAPTER_ORCHESTRATOR_URL`), which is the only sanctioned external call. `sign` polls synchronously and blocks the partition, so keep calls short.
- Two-phase chain transfer: put `{"pendingTransfer": {unsignedTx, chainId, from, to, contractAddress, value}}` in `state.custom_state`. The engine then sets the transaction to `awaiting_signature` and copies it into `response_data`.
- The `proxy_record` saga has **no compensation policy**, and proxy balances are a mirror, not chain-verified state. Don't build anything that relies on server-side chain verification without adding it.

### 9.4 Multi-token atomic op (e.g. pool mint, DvP-shaped)
Declare the extra tokens in class config:

```json
"additionalStateRequirements": [
  {"key":"loans","tokenClass":"LOAN-NFT","tokenIdsFrom":"payload.data.loan_token_ids","operations":["mint"],"multiple":true}
]
```

For create verbs the path is under `data.` after unwrap. `ownerFrom` supports `initiator | payload.<field> | identity.<type>`. `filters` is accepted but ignored. Read `ctx.get_additional_state("loans")` (`multiple:true` → a container whose `data` is a JSON array of `TokenState`), mutate, and return **every** token in `affected_states` (`is_new:false`, bumped versions and recomputed commitments). They're persisted in one sql tx. Known wart: the engine records the **message class's** commitment config in `state_history` for every affected state (F7).

---

## 10. Pitfalls

| Pitfall | Symptom | Fix / guidance |
|---|---|---|
| **`domain_lifecycle` unwrap reshapes the payload.** Non-create verbs get `payload.data` contents, not `payload`. | Your field isn't found; `InvalidPayload` | Put program fields in `extensions.<programId>` (always passed through). For `data` fields, read them top-level after unwrap. |
| Create op not named `mint`/`add`/`loan_originated`/`import` | API: `token_id_required_for_domain_lifecycle_update`; engine: `TokenNotFound` | Rename to `mint` or edit all three create-verb lists (engine unwrap, engine resolution, units-api `isDomainLifecycleCreateOperation`). |
| `metadata.fungible` missing on a unique-token class (defaults to **true**) | Mint fails `Mint payload must include an Issuer or Owner identity`, or a second mint updates the first token | Set `"fungible": false` in class metadata. |
| **Identity types don't round-trip.** The engine `IdentityType` is `issuer, creator, owner, co-owner, operator, viewer, access` (lowercase). Others are dropped on load or fail deserialisation. `access` is excluded from the hash. | `DATA_INTEGRITY_VIOLATION` on the second op; `INVALID_PAYLOAD unknown variant` | Only emit valid types. Keep `owner` == `identities[type=owner].id`. Exactly one owner. |
| **Commitment chain breaks** | `DATA_INTEGRITY_VIOLATION` (non-retryable → DLQ) on the *next* op, not the faulty one | Use the exact §3.3 tail. Always use the **class** config (`state_commitment_config()`). Use millisecond-stable `updated_at = ctx.timestamp`. Never patch state from post-hooks. Write a "recompute == stored" unit test. |
| Not all JSON round-trips | Same as above | Avoid floats and non-canonical numbers in `data`. Don't depend on map key order. Avoid fields with `skip_serializing_if` defaults that differ after a DB round-trip. |
| `operationOverrides` stored but **not enforced** | `{"transfer":{"disabled":true}}` has no effect | Enforce in `validate_operation` (e.g. read a `config.<program>.disabledOps` key) until the engine implements it. |
| **Voucher capability bug.** `semi_fungible_policy_bound()` lacks `DomainLifecycle`/`Mint`. | `purpose-bound-voucher` mint/issue/redeem → `CAPABILITY_DENIED` | Fixing it means adding `DomainLifecycle` to the preset (changes the published capability for vouchers; **ask first**). Don't copy that preset for new domain-op programs. |
| Unknown or typo'd hook id | Silently no enforcement | Grep engine logs for the hook-skipped warn. Add an integration check. |
| `HookConfig.config` ignored | Hook never sees its config | Use class metadata/config. |
| `supported_standards()` case or spelling mismatch | Async `UNSUPPORTED_TOKEN_STANDARD` | Copy the class `tokenStandard` byte-for-byte. |
| Forgot to re-publish capability | Sync `400 primitive_capability_missing` / `operation_not_supported` | §4.2. |
| `Utc::now()` inside programs | Non-deterministic replay, flaky tests | `ctx.timestamp`. |
| `InternalError`/`StateConflict` treated as retryable | They aren't. Program errors are never retried. | Return precise, user-meaningful errors. Transient infra issues are the engine's job. |
| Loan program ids hard-coded in the engine | — | `loan-nft-program`/`loan-pool-nft-program` get special `TokenNotFound` handling. Don't reuse those ids. |
| Old test scripts (`scripts/test-kafka-produce.sh`, `test_loan*_flow.sh`) | Rejected by the federation gate | Test through units-api, or hand-craft `opSeq`/`callerInstance`/`requestEnvelope` **and** pre-insert the `primitive_ops` row (otherwise the in-tx CAS update fails → `RowNotFound` → retry → DLQ). |
| Owner lookup picks the oldest token | Wrong NFT when `tokenId` is omitted | Always require `tokenId` for non-create ops (units-api already does for domain_lifecycle). |

---

## 11. Review checklist (PR into units-token-runtime)

- [ ] `program_id` is unique, kebab-case, and identical in code, seeds and docs. The standard whitelist matches the class `tokenStandard` exactly.
- [ ] `primitive_capabilities()` uses a preset that contains every outer verb you expect (`DomainLifecycle` for domain ops).
- [ ] The create op is `mint` (or `add`/`import`/`loan_originated`). Every other op rejects `state_version == 0`, and create rejects `state_version > 0`.
- [ ] Custom fields are read only from `extensions.<program-id>` through `PrimitivePayload`. Untrusted namespaces aren't trusted.
- [ ] No I/O, `Utc::now()` or randomness (UUIDs come from the engine: `new_for_mint`).
- [ ] The commitment tail is exact. `affected_states` lists every mutated token with the correct `is_new`. `owner` matches the owner identity, and identity types are valid.
- [ ] Policy comes from class metadata or config with safe defaults. No reliance on `operationOverrides` or `HookConfig.config`.
- [ ] Unit tests cover the happy path per op, create-on-existing, op-on-missing, bad payload, policy limits, commitment recompute == stored, and `previous_commitment` chaining.
- [ ] Registered in the workspace, registry `Cargo.toml` and `register_default_programs()`. Hooks registered if any.
- [ ] `make test`, `make lint` and `make fmt` are clean. CHANGELOG entry added.
- [ ] Any units-api change (standard routing, create verbs, recipes) is in a linked PR. A Flyway DDL change, if any, is in **units-api** `specs/db/V<NN>__*.sql` and added to the Makefile `db-migrate` target and compose initdb mounts.
- [ ] Backward compatibility is answered explicitly: Kafka message shape, trait/interface types, DB columns, commitment preimage, capability document. If any changed, the user or owner has signed off.
- [ ] End-to-end verified on the local stack: mint → status `completed` → transact → `state_history` chain intact → `primitive_ops.engine_status='executed'`, `completion_status='sent'`.

---

## 12. Where to look in code

| Topic | Path |
|---|---|
| Trait, types, presets | `units-token-runtime/tokenPrograms/interface/src/{traits,types,context,hooks,primitive_payload,errors}.rs` |
| Commitment, snapshots, balance helpers | `tokenPrograms/programs/core/src/{commitment,helpers,balance_helpers,primitive_executor,fungible_balance,nft_balance}.rs` |
| Smallest real example | `tokenPrograms/programs/hello-token/src/program.rs` |
| Multi-token example | `tokenPrograms/programs/loan-pool-nft-program/src/program.rs` |
| Registration | `tokenPrograms/registry/src/registry.rs` |
| Engine pipeline, unwrap, gate, resolution | `tokenEngine/src/engine/executor.rs` (`execute_inner`, `unwrap_domain_lifecycle_payload`, `enforce_primitive_capability`, `get_or_create_token_state`, `load_additional_states`) |
| Hook runner | `tokenEngine/src/engine/hook_runner.rs` |
| Self-registration | `tokenEngine/src/db/repositories/token_program.rs` |
| API routing | `units-api/src/services/token.go` (`MintToken`, `TransactToken`, `supportsPrimitiveFederationTransfer`), `src/services/federation.go` (`StartDomainLifecycle`, `isDomainLifecycleCreateOperation`, `validateProgramExtensions`), `src/services/operation_planner*.go`, `src/controllers/ulip_primitives.go` |
| Authz | `units-api/src/authz/input.go`, `src/authz/policies/rbac.rego` |
| WASM / kernel direction (proposals, not built) | `tokenPrograms/docs/WASM_COMPATIBILITY.md`. The platform intends class-only self-serve on stock programs and an eventual WASM guest ABI. Don't add per-customer program crates as the onboarding story without discussing. |
