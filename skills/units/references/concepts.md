# UNITS concepts, data model and glossary

> Snapshot date: **2026-10-03**. UNITS changes often. Before you build on any detail here, check it
> against the live instance: `/v1/tokenclassconfig/get`, `/v1/tokenprogram/search`, and a test
> transaction polled to completion. If sources disagree, trust them in this order: behaviour seen live
> on sanctum, then current code (units-api, token-runtime), then `specs/` OpenAPI and JSON schemas,
> then public docs.

Contents
1. Finternet and UNITS in plain language
2. The three planes
3. Core objects, one by one
4. How the objects relate (ER diagram)
5. The token data model (with an annotated example)
6. Native vs proxy state modes
7. What UNITS is, and what it is not
8. Naming you will meet (aliases and stale names)
9. Glossary A–Z

---

## 1. Finternet and UNITS in plain language

**Networks for Humanity (NFH)** (https://nfh.global) is an international network of labs building open, interoperable digital infrastructure. It advances its purpose through **missions**, and **Finternet** is one of them (others include Beckn, DeDi, the Global Digital Energy Grid and Vouch). **UNITS** is the ledger and tokenisation platform at the core of the Finternet mission.

**Finternet** is the vision of a "financial internet". Any asset (money, a loan, a voucher, a KYC
credential, a warehouse receipt) becomes a **token**. That token can be held, moved and governed by
programmable rules across institutions and jurisdictions. Global consensus is not required. Public
docs describe three principles, the "3 U's":

| Principle | Meaning |
|---|---|
| **User-centric** | Users control their identity, keys and assets. By default no intermediary has custody. Personal agents act within delegations the user scoped. |
| **Unified** | One account gives one view of holdings across token managers, ledgers and jurisdictions. |
| **Universal** | Open to any participant, asset type or jurisdiction. Multi-instance by design: each account's data stays on its *home instance*, and a *global registry* holds only routing metadata. |

**UNITS** stands for "Unified Information Tokenisation System". Some pages write "Universal", and the
JSON-LD schemas call the token model the "Universal Token Specification". It is Finternet's
reference implementation: a federated ledger and token platform. In concrete terms, a UNITS
**instance** is:

- a Go REST API (`units-api`) that takes signed JSON envelopes,
- a Rust **token engine** that runs the business logic of pluggable **token programs**,
- Restate durable workflows that orchestrate multi-step and cross-instance operations,
- a PostgreSQL/YugabyteDB ledger, where each state change carries a hash-chained commitment,
- Keycloak for identity, Vault for PII encryption and server-held keys, and Kafka as the internal command bus.

Many instances form the Finternet network. Each account has exactly **one home instance**. A
central **registry** (in `units-services`) knows which instance is home for which account, and it is
also the authority for developer clients and their scopes, for delegations, and for instance
capability documents. Instances talk to each other with **ULIP**, a protocol of Ed25519-signed
envelopes.

The basic loop for an integrator:

```
register a token class ──▶ bind it to a token program (token class config) ──▶ mint
        ──▶ transact (transfer / burn / freeze / lock / domain ops) ──▶ poll status ──▶ read / prove
```

Every write is **asynchronous**. You get a `txId` back and poll for the result. UNITS has no webhooks.

---

## 2. The three planes

Public docs explain UNITS as three cooperating planes. The table maps each plane to the components that implement it.

```
          "who is acting"                 "what is permitted"              "what is true now"
 ┌──────────────────────────┐     ┌──────────────────────────────┐     ┌──────────────────────────┐
 │ IDENTITY & CREDENTIAL    │────▶│ POLICY ENFORCEMENT           │────▶│ TOKEN STATE              │
 │ accounts, DIDs, keys,    │     │ SA scopes, OPA/Rego RBAC,    │     │ tokens, balances, locks, │
 │ Keycloak JWTs, registry, │     │ delegations, token programs, │     │ state_history, chained   │
 │ credential tokens (VCs)  │     │ pre/post hooks               │     │ commitments, Merkle      │
 └──────────────────────────┘     └──────────────────────────────┘     │ batches, proxy mirrors   │
              ▲                                                        └────────────┬─────────────┘
              └─────────────────────────── state feeds back into identity ───────────┘
```

| Plane | Question it answers | Implemented by |
|---|---|---|
| **Token state** | Who holds what, under what conditions? | `tokens`, `token_transactions` (double-entry), `state_history` (versioned snapshots and commitment chain), `proofs` (BLAKE3 Merkle batches). Native tokens live in UNITS. Proxy tokens mirror an external chain. |
| **Policy enforcement** | Is this operation allowed, and what does it do? | Service-account scopes (registry), resource authorisation (OPA/Rego `rbac.rego`: owner, class manager, identity view, delegations), token programs (Rust, in the engine), configurable pre/post hooks, mandatory engine hooks (commitment verification, envelope verification, audit log). |
| **Identity & credential** | Who is acting, and what can they prove? | Accounts (`address`, `sha256(address)` identity, `did:units:0x…`), Keycloak realm `finternet` user JWTs, developer tokens (registry-resolved), the key registry (`key_references`), credential tokens (`credential` program, W3C VC shape), the central registry (names, contacts, home instances). |

Worked example, a credential-gated transfer. The identity plane establishes that the caller is the
account `alice` (JWT) and that the transfer payload was signed by Alice's registered Ed25519 key. The
policy plane then checks that the SA holds `tokens:transact`, that OPA confirms Alice owns the token,
and that a `credential-verification` hook (voucher programs) finds an Active credential. Finally the
state plane runs the saga Lock → CreateIncoming → CommitDebit → CommitCredit, writes debit and credit
rows, and chains a new commitment for each affected token.

---

## 3. Core objects

### 3.1 Account
A human or legal entity on Finternet. Its fields:

| Field | Notes |
|---|---|
| `address` | Human-readable handle you claim at signup, such as `alice` or `acme-ops`. Pattern `^[a-z0-9._-]+$` (lower-cased, max 255). Unique across the federation. |
| identity hash | `sha256(lower(trim(address)))` as hex without `0x`. This is the **stored identity**: the JWT `preferred_username` and the registry `accounts.address` primary key. It is **not** the DID. |
| `did` | `did:units:0x<hex of the account's Ed25519 public key>`. Derived from the key, not from the address hash. |
| `name` | Letters and spaces only. |
| `entityType` | `PERSONAL` or `BUSINESS` (`account.schema.json`). Older docs say "individual/Individual", which is stale. |
| contacts | Email and phone. Vault-Transit encrypted, plus a hash. `/v1/account/get` returns the address **masked**, so record the plaintext address and its hash at signup. |
| home instance | Exactly one per account. Logging in to an account homed elsewhere returns `409 FORWARD`. |

There are two ways to refer to an account, and mixing them up is **the biggest integration trap**:

| Use the **plaintext address** (`alice`) in | Use the **hash** (`sha256("alice")`) in |
|---|---|
| `transact.to`, delegation `grantee_address`, class `identities[].id`, `/clients/register identities[].address`, `/v1/address/*` | `/v1/token/add` `owner` (sessionless B2B issuance), the `credentialSubject.id` convention, the identity ids stored on tokens |

Public docs describe an "address = controller, account = container" split, with multi-address accounts
controlled by MPC keys. The code does not implement that split. Treat an account as one handle with one identity hash.

### 3.2 DID
A W3C Decentralized Identifier. The deployed form is `did:units:0x<64 hex>`, the raw Ed25519 public
key of the account's key (server-held in Vault Transit at signup, or wallet-supplied). The registry's
signed NameRecord binds address → DID → home instance. Docs and schemas also show `did:web:`,
`did:key:`, `did:fi:` and `did:nfh:`. Those are illustrative or stale. **`GET /v1/did/:address` is
disabled.** Use `POST /v1/address/resolve` instead.

### 3.3 Key (key registry)
A public key bound to an account, stored in units-api `key_references`. It is ed25519 for signing
envelopes, or ed25519/secp256k1 wallet keys for proxy-token discovery. You register keys with
`/v1/account/keys/register` and list them with `/v1/account/keys/search`. `/v1/account/keys/create` makes a
platform-managed (custodial) key. `/v1/account/sign` signs a payload with the server-held key after an
OTP challenge. The `keyId` of an active ed25519 key goes into the envelope `signature`. Key rotation
currently returns 501.

### 3.4 Token class
The **type or definition** of a token, like a class or contract definition. You register it with
`/v1/tokenclass/register` (alias `/v1/registry/tokenclasses/register`). It is synchronous and returns `tokenClassId` (a UUID).

| Field | Meaning |
|---|---|
| `tokenClass` | Short code. The server **upper-cases** it and it is **globally unique** across tenants. |
| `tokenStandard` | One string. It must exactly match a standard the bound program whitelists, otherwise the operation fails asynchronously with `UNSUPPORTED_TOKEN_STANDARD`. |
| `name`, `description` | Display. |
| `schema` | JSON Schema for instances. **Documentation only, not enforced** (the validator is unwired). Programs do their own validation. |
| `identities` | Who may mint (`type: issuer`). If omitted or `[]` at registration, the registering caller is stamped as owner and issuer. A class whose *stored* identities are `[]` (seeded NFH-T and SODEXO-MV, or set via update) has no issuer restriction, so always list issuers on classes you create. |
| `metadata` | `decimals` (display ↔ raw), `symbol`, `category`, `fungible`, `transferable`, `divisible`, `burnable`, `revocable`, `soulbound`, `contractIds{CAIP-2 → address}` (proxies), `valuation`, `maxSupply`, `minBalance`, `redeemableCategories`, `escrowCurrency`, `valueCurrency`, `allowedMinters`, `defaultValidityDays`. |

Whoever registers a class owns it. Use **one operator account** (a real UNITS user account owned by
your organisation) for every class registration and platform write.

### 3.5 Token class config ("config")
The **binding** from a class to a program, plus engine behaviour. You register it with
`/v1/tokenclassconfig/register` (synchronous). Each class has exactly one. **Without a config, every
operation fails** with `INVALID_INPUT: primitive_capability_missing` (in older builds, `ConfigNotFound`).

```json
{
  "tokenClass": "ACME-PTS",
  "tokenClassId": "<uuid from class register>",
  "programId": "fungible",
  "preHooks":  [{"hookId": "max-supply", "priority": 1, "enabled": true, "operations": ["mint"]}],
  "postHooks": [{"hookId": "logging", "priority": 100, "enabled": true}],
  "operationOverrides": {},
  "config": {"stateCommitmentAlgorithm": "sha256"}
}
```

Config keys: `stateCommitmentAlgorithm` (`sha256` default, or `blake3`), `stateCommitmentFields`,
`includeDataInCommitment`, `includeRelationshipsInCommitment`, `additionalStateRequirements[]` (load
other tokens into the same atomic execution), `credentialVerification{requiredCredentials[],
additionalStatesKey}`, `voucherTransfer{enabled}`, `defaultValidityDays`. `operationOverrides` (for
example `{"transfer":{"disabled":true}}`) is **stored but not enforced** by the engine today.

### 3.6 Token program
**Business logic written in Rust** that implements the `TokenProgram` trait inside the token engine. A
program declares which standards it accepts, which operations it supports and with what payloads, how
to validate, how state changes, and which federation primitives it supports (`PrimitiveCapabilities`).
Programs are compiled into the engine binary and **self-register** into `token_programs` at engine
boot. `/v1/tokenprogram/register` can create a row, but only engine code can make an operation
executable. **Integrators choose a program. They cannot deploy one.** A custom program is Finternet
engineering work, measured in days per program. Dynamic WASM loading is on the roadmap only.

| programId | tokenStandard(s) accepted | What it does | Create via |
|---|---|---|---|
| `fungible` | UNITS-FT, ERC-20, ERC-3643 | balances/supply: mint, burn, transfer, freeze, unfreeze, lock, unlock, update | `/token/mint` |
| `non-fungible` | UNITS-NFT, ERC-721 | unique ownership: mint, burn, transfer (`local_transfer` same-instance), lock/unlock | `/token/mint` |
| `credential` | UNITS-CREDENTIAL, UNITS-SBT, W3C-VC-2.0 | soulbound W3C VC: add, revoke, suspend, resume (no transfer/burn) | `/token/add` |
| `stables` | PROXY-FT | proxy of on-chain stablecoins/assets: import, reconcile, transfer, sign | `/token/add` (chain fields) |
| `purpose-bound-voucher` | UNITS-SFT | category-capped voucher: mint, issue, redeem, revoke | **blocked**: mint/issue/redeem fail `CAPABILITY_DENIED` on current builds |
| `loan-nft-program` | UNITS-Loan (also UNITS-NFT, UNITS-LOAN) | loan lifecycle; `mint` aliases `loan_originated`; 22 domain ops | `/token/mint`, then `/token/transact` |
| `loan-pool-nft-program` | UNITS-LoanPool (also UNITS-NFT, UNITS-LOANPOOL) | securitisation pool: mint, dpd_bucket_updated, principal_update, payout, irr_update, fldg_update, pool_rating_updated, pool_closed | `/token/mint` (pool fields snake_case) |
| `hello-token` | UNITS-HELLO | onboarding exemplar for program authors | — |

### 3.7 Identities and roles
`identities[]` on a class or token is a list of `{id, type, name?, roles?}`. Token identity types
(lowercase) are `issuer`, `creator`, `owner`, `co-owner`, `operator`, `viewer` and `access`. Any other
type fails asynchronously with `INVALID_PAYLOAD` (unknown variant). Schemas also mention `custodian`,
`manager`, `controller`, `subject`, `holder` and `verifier`, but the engine does not accept them on tokens.

- `owner`: holds the token. OPA lets the owner do everything.
- `issuer`: may mint against the class (class-level). It is also recorded on minted tokens.
- `access`: stamped automatically when a delegation is granted, and **excluded from the state commitment**.
- Any identity on a token may **view** it.

**Do not send `identities[]` on `/v1/token/mint`.** The engine fills issuer, creator and owner from the
caller. A hand-written array replaces those values, the ids get re-hashed, and later transacts fail with
`FORBIDDEN no_matching_allow_rule`. This was verified live.

### 3.8 Relationships and claims
`relationships[]` (the engine name; earlier docs say "claims" or "dependency pointers") holds
W3C-VC-shaped `Claim` objects (`@context`, `type`, `issuer`, `issuanceDate`, `credentialSubject`,
`proof{jws}`, `status asserted|verified|revoked|expired`), attached at mint through `claims`.
**Claims are stored and echoed back; UNITS does not validate them**, and nothing queries them as a
dependency graph. Verifiers should validate provenance themselves. Public docs describe `AddClaim`/`RevokeClaim` operations. There
is no generic add-claim or revoke-claim operation. Credential lifecycle belongs to the `credential` program.

### 3.9 State and state commitment
`state` holds a token's mutable lifecycle data: `status`, `balance` (the authoritative gross holding),
`supply` (issuer token), `locks[]` (federation locks keyed by `(txn_id, op_seq)`), `incoming[]` (pending
inbound credits), `balanceRollup`, `restrictions`, `customState`, `effectiveFrom/Until`.

Every write increments `stateVersion`, sets `previousCommitment` to the old commitment, and computes a
new **state commitment**: a hash over the previous commitment, last tx id, timestamp, token id, owner,
identities (without `access`), relationships, state and version. Fields are selectable, and the
algorithm is sha256 by default or blake3. Before the next operation, the engine **re-computes and
verifies** the stored commitment. A mismatch is `DATA_INTEGRITY_VIOLATION`. The result is a per-token,
**hash-chained, tamper-evident** history in `state_history`.

### 3.10 Transaction
A unit of asynchronous work (`transactions` row, `id = txId`). Mint, transact and add return `txId` with
`status: "submitted"`. Poll `/v1/transaction/status {txId}` until the status is terminal: `completed`,
`failed` or `cancelled` (`awaiting_signature` means a proxy flow is waiting for a user-signed chain tx).
`metadata.affectedTokenIds` lists the tokens touched. Federated transfers also carry a lifecycle,
`status_v2`: SUBMITTED → PREPARED → COMMITTING → COMMITTED, with off-paths ABORTED, AUTO_REVERSING,
REVERSED and STUCK. You read it through `/v1/transactions/status {"txn_id"}`.

### 3.11 token_transaction (double-entry)
`token_transactions` has one row per token touched by a transaction. Each row holds `operation` (the
resolved verb), `entry_type` (`debit`, `credit` or NULL), `participants[{accountId, role}]`,
`units{value, unit}`, and full `state_before` and `state_after`. A transfer produces a **debit** row on
the source token and a **credit** row on the destination token under the same transfer txn. You read
them with `/v1/token/transactions` (tenant-scoped, `dateRange`).

### 3.12 Proof
Two layers:
1. **Per-token commitment chain.** Live on every write (see 3.9).
2. **Merkle batch proofs.** `proofService` (Rust) batches *completed* transactions with their
   value-moving token transactions into a BLAKE3 Merkle tree, stores one `proofs` row per batch and
   stamps `proof_id`. It only runs when a **full batch** (`MERKLE_BATCH_SIZE`) has accumulated, so
   proofs are often `pending` on quiet environments. Endpoints are `/v1/transaction/proof`,
   `/proof/leaf` and `/proof/verify`. `verify` is structural only (it recomputes the path). **Chain
   anchoring is on the roadmap** (`ledger_anchors` is always NULL).

### 3.13 Delegation
A grant from a **grantor** to a **grantee** of a permission (`view`, `transact` or `manage`) over resources selected by a **label**:

| Label form | Selects |
|---|---|
| `tokens:id:<uuid>` | one token |
| `tokens:tokenclass:<CLASS>` | every token of a class held by the grantor |
| `tokens:*` | every token the grantor holds |
| `tokens:tokenclass.metadata.status:active` | a JSONB field match |

Rule type is `allow` or `deny`, and **deny wins**. `expires_at` and `allowedOperations` dot-path
narrowing are optional. Owner-initiated grants activate immediately. Non-owner requests go **pending**
on a Restate workflow with a 7-day approval timer. Create a delegation with `/v1/workflows/execute
{workflow:"delegation-create", action:"allow"|"deny"|"approve"|"reject"|"cancel", data:{…}}`, revoke one
with `{workflow:"delegation-revoke", action:"revoke", data:{delegation_id}}`, list them with
`/v1/delegations/list` and check one with `/v1/delegations/check`. Delegations are stored in the
central registry. Granting one stamps an `access` identity onto matching tokens on every instance.
Label resolution is always scoped to what the grantor holds.

### 3.14 Scope
A permission on a developer client (service account) in the form `entity:action`. Actions are `view`,
`create` and `manage`, plus `transact` on tokens. Examples: `tokens:create`, `tokens:transact`,
`tokenClasses:create`, `tokenClassConfigs:create`, `accounts:manage`, `clients:*`, `terms:manage`. The
registry's `scope_apis` table maps each API id to one scope. An unmapped API id fails closed with `500
SCOPE_MAPPING_NOT_CONFIGURED`. A missing scope gives `403 CLIENT_INSUFFICIENT_SCOPE`. Protected scopes
start out **pending** until a super-admin approves them.

### 3.15 Client, developer token and service account
An **API client** (developer client) is a registered consumer owned by an account. It is a
service account `sa-<uuid>`, held authoritatively in the registry. Its credential is the **developer token** `base64("sa-<client-uuid>:<clientSecret>")`,
which always starts with `c2Et`. The token goes in `context.developerToken` on **every** call, and it
is shown once at `/v1/clients/register`. Rotate it with `/v1/clients/rotate-secret {clientId,
graceSeconds}`. Each request resolves the token against the registry: a hash lookup returns a
registrar-signed bundle of scopes, allowedOperations, rate tier and owner address. If the registry is
unreachable, every authenticated call fails with `503` (fail closed). Client registration currently
needs a superadmin SA ("interim governance"). Integrators self-serve through the web portal page
"API Access → Register client" (see portals-and-access.md), or ask the Finternet platform team.

### 3.16 Terms (consent)
Legal documents (`terms_of_use`, `privacy`), stored in `terms_versions` and accepted per user in
`user_consents`. The endpoints are `/v1/terms/get`, `/v1/terms/accept` and `/v1/terms/publish`. A
version with `requiresReconsent` forces users to accept again. The error code `TERMS_CONSENT_REQUIRED`
(403) exists; enforcement is environment-dependent, so record consent at signup regardless.

### 3.17 Workflow
A durable, multi-step process on **Restate** (`units-workflows`). The registered workflows are
`primitive-operation` (the generic saga engine behind every token write), `delegation`,
`delegation-revoke` and `profile-update` (OTP-gated changes to email, mobile or name). The `gateway`
app hosts all of them. Workflows are listed in `workflow_registry`. The generic API is
`/v1/workflows/execute|status|cancel`: the first action starts a workflow (202, id
`{workflow}-{uuid}`), and later actions signal it.

### 3.18 Adapter
A service that bridges UNITS to an external ledger. **Chain adapters** (for example
`alchemy-chain-adapter`, which covers about 20 EVM mainnets, testnets and Solana) implement
`/api/v1/chain-adapter/{accounts/holdings, balance/get, transactions/build|submit|status}`. The
**adapter orchestrator** routes each request by the CAIP-2 `context.chainId`, using `adapter_registry`
and taking the highest-priority active row. Proxy tokens depend on adapters.

### 3.19 Chain registry and wallet provider registry
`chain_registry` (units-api) lists the blockchain networks an instance knows: `networkId` CAIP-2,
`chainFamily` (evm/solana/…), `isTestnet`, status, metadata. 31 canonical CAIP-2 chains are seeded.
`wallet_provider_registry` is an allow-list of wallet apps (EIP-6963 `rdns`, supported chains, status).
Neither is federated: each instance keeps its own.

### 3.20 Instance, home instance and registry
- **Instance**: one complete UNITS deployment, identified by an immutable UUID `instance_id` plus a
  display name, `api_url`, `ulip_url` and an Ed25519 signing key. The flat environments (dev, staging,
  prod) each run one instance today.
- **Home instance**: the one instance that holds an account's data, tokens and history. The portal
  routes your session to it.
- **Registry** (also called the registrar or central registry): a Go service in `units-services`. It
  keeps signed NameRecords (address → DID → home), contact-hash → home resolution, the instance
  catalog with capability documents, instance public keys, developer clients, keys, the scope
  catalogue, rate tiers, delegations, OIDC clients, and central OTP login. Its trust anchor is the
  registrar Ed25519 key `registrar-key-1` under namespace `registrar.finternet.lab`. It **does not**
  hold chains, adapters or token classes, which stay per instance.

### 3.21 ULIP
The UNITS inter-instance protocol. Its envelope is `{context:{ulip_version:"v1", method, txn_id,
op_seq, caller_instance, callee_instance, sent_at}, payload, signature:{signer_instance, key_id,
algorithm:"ed25519", signature}}`. The signing input is `JCS(context) ‖ JCS(payload)`. ULIP carries
every federation primitive (Lock, CreateIncoming, CommitDebit, CommitCredit, Unlock, RejectIncoming,
Credit, Debit, RecordProxyEntry, Reconcile, DomainLifecycle, PruneTokenTransactions) and the registry
methods (RegisterName, ResolveName, DelegationApprove, and so on). The callee de-duplicates on
`(caller_instance, txn_id, op_seq)`.

### 3.22 Proxy vs native state mode
See section 6.

---

## 4. How the objects relate

```
                                   ┌───────────────────────────── CENTRAL REGISTRY ──────────────────────────────┐
                                   │  NameRecord(address→DID→home)  Instance(+capability doc, pubkey)             │
                                   │  DeveloperClient(sa-uuid)──<Scope>   Delegation(grantor→grantee,label,perm)   │
                                   └──────▲───────────────▲─────────────────────────▲─────────────────────────────┘
                                          │ home          │ owns (owner_address)    │ grantor/grantee (hash)
                                          │               │                         │
 ┌───────────┐ 1   n ┌──────────────┐     │        ┌──────┴───────┐                 │
 │  Account  │──────▶│ Key (key_    │     │        │  API client  │──credential──▶ developer token
 │ address,  │       │ references)  │     │        │ (service     │                (context.developerToken)
 │ sha256 id,│       │ keyId,ed25519│     │        │  account)    │
 │ DID, home │◀──────┴──────────────┘     │        └──────────────┘
 └─┬───┬─────┘ signs envelope (signature.keyId)
   │   │
   │   │ registers (owner/issuer)          1        1
   │   └──────────────────────────────▶ ┌────────────┐ ───── bound by ─────▶ ┌──────────────────┐ n ──▶ 1 ┌───────────────┐
   │                                    │ TokenClass │                       │ TokenClassConfig │────────▶│ TokenProgram  │
   │                                    │ tokenClass │◀──── tokenClassId ────│ programId,hooks, │         │ (Rust, engine)│
   │                                    │ standard   │                       │ config           │         │ standards,ops │
   │                                    └─────┬──────┘                       └──────────────────┘         └───────────────┘
   │ identity (owner/issuer/…)                │ 1
   │ stored as sha256(address)                │
   │                                          │ n
   │           n  ┌──────────────────────────────────────────────┐
   └─────────────▶│ Token  (tokens row)                            │──── n ──▶ relationships[] (claims / VC-shaped)
                  │ metadata · data · identities · relationships ·│
                  │ state · stateCommitment · stateVersion        │──── 1:n ──▶ state_history (version, snapshot,
                  └───────┬───────────────────────────────▲───────┘                    commitment, previous_commitment)
                          │ 1                             │
                          │ n                             │ n
                  ┌───────▼─────────────┐  n     1 ┌─────┴──────────┐  n     1 ┌──────────────┐
                  │ token_transaction    │─────────▶│  Transaction   │─────────▶│ Proof (batch │
                  │ debit/credit,before/ │          │ txId, status,  │ proof_id │ Merkle root, │
                  │ after, participants  │          │ status_v2      │          │ BLAKE3)      │
                  └──────────────────────┘          └──────┬─────────┘          └──────────────┘
                                                           │ 1:1 (txn_id = workflow id)
                                                    ┌──────▼─────────────────────┐   1   n  ┌───────────────────┐
                                                    │ Workflow (Restate          │─────────▶│ primitive_ops /    │
                                                    │ primitive-operation saga)  │          │ workflow_ops       │
                                                    └────────────────────────────┘          │ (txn_id, op_seq)   │
                                                                                            └───────────────────┘
 Proxy tokens additionally:  Token.chain_id/contract_id/wallet_address ──▶ ChainRegistry(CAIP-2) ──▶ Adapter (adapter_registry)
```

Cardinalities to remember:
- 1 class has 1 config, and 1 config points at 1 program. One program can serve many classes.
- **Fungible tokens: 1 row per (owner, class).** A second mint to the same owner adds supply to the
  existing row, and credits also merge into the owner's row. Fungible tokens have no batch or lot identity.
- NFT, loan and pool tokens: 1 row per instrument. `initialSupply` is `"1"`.
- 1 transfer gives 1 transaction (the saga), several `primitive_ops` (one per step) and 2 `token_transactions` (debit and credit).

---

## 5. The token data model

Public docs and schemas describe a five-section token (Metadata, Data, Claims, Identities, State). The
engine's `TokenState` adds the commitment fields. Treat a token as **six sections**:

| Section | Mutable? | Who writes | Purpose | Commitment? |
|---|---|---|---|---|
| **metadata** | rarely (`update`) | mint / `update` | Identity and behaviour: `name`, `symbol`, `decimals`, `tokenStandard`, `fungibility`, `flags{transactable, transferable, locked, revocable}`, `tags{}`, `description`, `externalUrls`. | no (not in default field set) |
| **data** | yes | program / `update` (shallow merge) | Program-defined domain data, such as loan terms, voucher limits or a credential VC body. Not schema-enforced. | only if `includeDataInCommitment` |
| **identities** | yes | engine (mint), transfer, delegation reconcile | `[{id: sha256(address), type, name?}]`: owner, issuer, creator, operator, viewer, co-owner, access. | yes (except `access`) |
| **relationships** | at mint | mint `claims[]` | VC-shaped claims and dependency pointers. Stored, not verified. | yes by default |
| **state** | yes | program only | `status`, `balance`, `supply`, `locks[]`, `incoming[]`, `balanceRollup`, `restrictions`, `customState`, `effectiveFrom/Until`. | yes |
| **commitment** | every write | engine/program | `stateCommitment`, `previousCommitment`, `stateVersion`, `lastTxId`. | (it *is* the commitment) |

Token statuses: `active`, `frozen`, `redeemed`, `burned`, `expired`, `pending`, `rejected`, `transferred_out`.
Credential tokens reuse these: suspended = `frozen`, revoked = `burned` (there is no separate `suspended`/`revoked` status).

### 5.1 Annotated example: a fungible holder token

This example is **illustrative**. It follows the engine's `TokenState` (camelCase). `/v1/token/get`
returns a close variant, which may use `id` instead of `tokenId` and may add `tokenClassInfo` and
`chainRegistryInfo`. Check against a live response. Comments (`//`) are annotations only and are not part of the JSON.

```jsonc
{
  "tokenId": "0196f3a2-7c1e-7b9a-9d1e-2f6a1c0b9e01",   // UUIDv7, assigned by the engine at mint (mint does NOT return it)
  "tokenClassId": "0196f39f-1111-7abc-8def-000000000001", // from /v1/tokenclass/register
  "tokenClass": "ACME-PTS",                              // class code, upper-cased, globally unique
  "tokenStandard": "UNITS-FT",                           // must be whitelisted by programId "fungible"
  "owner": "2bd806c97f0e00af1a1fc3328fa763a9269723c8db8fac4f93af71db186d6e90",
                                                         // derived from identities[type=owner]; = sha256("alice")
  // ── metadata ────────────────────────────────────────────────────────────────
  "metadata": {
    "name": "Acme Loyalty Points",
    "symbol": "APTS",
    "decimals": 2,                                       // display "12.50" ⇄ raw "1250"
    "fungibility": "fungible",
    "tokenStandard": "UNITS-FT",
    "flags": { "transactable": true, "transferable": true, "locked": false, "revocable": false },
    "tags": { "program": "spring-2026" }                 // map in the API (schemas show an array)
  },
  // ── data (program/domain data; free-form; NOT validated against class schema) ─
  "data": { "campaign": "SPRING-26", "externalRef": "crm-88213" },
  // ── identities (ids are sha256(lower(trim(address))) hex, no 0x) ─────────────
  "identities": [
    { "id": "2bd806c9…6e90", "type": "owner",  "name": "Alice" },
    { "id": "9f1c44aa…01b2", "type": "issuer", "name": "Acme Ops" },  // class issuer (your operator account)
    { "id": "77aa01de…c3f0", "type": "access", "name": "Budget App" } // stamped by delegation; excluded from commitment
  ],
  // ── relationships (claims; stored verbatim, never verified) ──────────────────
  "relationships": [],
  // ── state (only the program writes this) ─────────────────────────────────────
  "state": {
    "status": "active",
    "balance": "1250",                                   // AUTHORITATIVE gross holding, base units, string (u128)
    "locks": [                                           // federation locks, keyed (txnId, opSeq)
      { "locked": true, "txnId": "0196f3b0-…", "opSeq": 1, "value": "250", "lockReason": "transfer" }
    ],
    "incoming": [],                                      // pending inbound credits (destination side of a saga)
    "balanceRollup": { "available": "1000", "lockedTotal": "250", "incomingTotal": "0", "total": "1250" },
    "effectiveFrom": "2026-10-01T09:12:44.120Z"          // processing time, not business-effective time
    // issuer's own token would also carry "supply": {totalSupply, circulatingSupply, usedSupply, availableSupply}
  },
  // ── commitment ───────────────────────────────────────────────────────────────
  "stateVersion": 4,                                     // optimistic-lock version; +1 per write
  "lastTxId": "0196f3b0-…",
  "previousCommitment": "e3b0c442…b855",                 // = commitment of version 3
  "stateCommitment": "5f2a90d1…77c3",                    // sha256 (default) or blake3 over the configured field set
  "createdAt": "2026-10-01T09:12:44.120Z",
  "updatedAt": "2026-10-03T10:00:00.000Z"
}
```

What you can see in it:
- `available = balance − locked`. A pending incoming credit joins `balance` only at `commit_credit`.
- Issuer invariants on the issuer token: `circulating = available + used`. A user burn **returns
  units to the issuer pool**. Only an issuer burn reduces circulating supply.
- Amounts are always **strings**: base-unit integers in `raw`, or decimals in `display`. Set
  `context.valueFormat` explicitly. The code default is `display`, although the schema text says `raw`.
- A proxy token also carries `chain_id`, `contract_id` and `wallet_address` (columns copied from
  `data.chainId/contractAddress/walletAddress`). A non-null `chainId` means the token is a proxy.

### 5.2 Mint and transact payload shape (for orientation)

```json
{ "tokenClass": "ACME-PTS", "initialSupply": "100000",
  "metadata": {"name": "Acme Loyalty Points"}, "data": {"campaign": "SPRING-26"},
  "extensions": {"fungible": {}} }
```
```json
{ "operation": "transfer", "tokenId": "0196f3a2-…", "to": "bob", "value": "250" }
```
Everything is an `operation` on `/v1/token/transact`. There are no separate `/burn` or `/freeze`
endpoints. The amount field is `value`, never `amount`. Domain operations carry their own fields in `data`.

---

## 6. Native vs proxy state modes

| | **Native** | **Proxy** |
|---|---|---|
| Source of truth | The UNITS Postgres/Yugabyte ledger | An external ledger (EVM chain, Solana, potentially a core-banking or custodian system) |
| Typical standards/programs | UNITS-FT/NFT/SFT, credential, loan, pool | `PROXY-FT` → `stables` |
| How tokens appear | `/v1/token/mint` (or `/token/add` for credentials) | `/v1/token/add {tokenClass, chainId (CAIP-2), contractAddress (= class metadata.contractIds[chainId]), walletAddress (a registered key of owner), value}`. Linking a wallet key also triggers holdings discovery. Re-adding re-syncs (reconcile). |
| Transfers | Saga (Lock → CreateIncoming → CommitDebit → CommitCredit), settled on commit | `proxy_record` recipe (RecordProxyEntry → Debit → RecordProxyEntry → Credit). It may pause at `awaiting_signature` with an unsigned chain tx for the user to sign, then the user submits through the adapter. **No compensation policy.** |
| Commitments | Full per-token chain | Chain over the shadow state only. Finality depends on the external chain. |
| Honest caveats | — | Treat proxy balances as a mirror, not chain-verified state. The shadow goes stale if the user transacts on-chain directly. Not "interoperability", only a mirror. |

The seeded proxy classes are 22 stablecoin/native PROXY-FT classes (USDC, USDT, EURC, ETH, SOL, BTC,
DAI, PYUSD, FDUSD, USDe, USDS, GHO, RLUSD, FRAX, USDP, GUSD, crvUSD, LUSD, TUSD, XSGD, EURS, GYEN).
USDe and crvUSD are unreachable because of a case bug.

---

## 7. What UNITS is, and what it is not

**What it is (safe to claim):**
- A **multi-tenant, account-based token ledger on PostgreSQL/YugabyteDB**. The Go API authenticates,
  authorises and plans. A single Rust engine is the only writer of token state, and it applies all
  state changes from one primitive in one SQL transaction with optimistic locking.
- **Hash-chained, tamper-evident** per-token history (`state_history`), with commitments verified before each operation.
- **BLAKE3 Merkle batch proofs** of completed transactions. They give internal tamper evidence and only appear once a batch fills.
- **Quantity-conserving transfers.** u128/big.Int integer arithmetic, no floats, underflow rejected,
  and a durable two-phase prepare/commit saga with compensation and an honest `STUCK` state.
- **Multi-token atomic commits**, including across classes (loan-pool mint updates the pool and the member loans together).
- **Federation**: home instances, a signed registry, Ed25519 ULIP envelopes, and capability documents.
- Identity and authority: DID accounts, Keycloak OIDC, registry-resolved developer tokens with scopes, envelope signatures checked against registered keys, and OPA/Rego RBAC with per-permission delegations and deny shadowing.
- A transactional outbox and Restate durability for every step.

**What it is not (do not claim):**
- **Not a blockchain.** There is no consensus, no smart contracts (zero `.sol`), no censorship resistance and no trustless validation. Trust is institutional, backed by verifiable commitments.
- **ERC-20 / ERC-721 / ERC-3643 are program selectors, not compliance.** The label only selects a Rust program and balance model.
- **Not anchored on-chain.** `proofs.ledger_anchors` is never written. Anchoring and public root publication are on the roadmap ("Proof Service").
- Class schemas are **not enforced**. `operationOverrides` is **not enforced**.
- Credential tokens hold VC data. Verifiers should validate credential provenance (expected token class, VC `issuer`, provider signature/evidence, and confirmation from the issuing provider) rather than relying on class membership alone.
- Don't make claims about encryption at rest, anchoring or audit immutability to your users; confirm current guarantees with Finternet.
- **Not idempotent per request.** There is no idempotency key, and a retried mint creates a second mint. Dedupe on your own business ids, and use a fresh `msgId` for each attempt.
- No webhooks or event stream for integrators. You poll.
- There are no batch, lot or lineage identities for fungibles, no transformation (N→M) primitive, no scheduled or time-driven operations, and no DvP `settle`.
- External teams cannot ship programs (custom programs need an engine release).

**Roadmap (designed, not built):** a Proof Service (standalone proofs, public root publication,
signed commitments), dynamic WASM program loading, DigiLocker credential import, a DvP settle
operation, a batch-SFT primitive, an idempotency key, and webhooks from the outbox.

---

## 8. Naming you will meet

| You may see | Means / current name |
|---|---|
| `reference-ft`, `reference-nft`, `reference-credential` | `fungible`, `non-fungible`, `credential` |
| `nfh-voucher`, "NFH Voucher" | `purpose-bound-voucher` (blocked) |
| `loan-nft`, `loan-pool-nft` | `loan-nft-program`, `loan-pool-nft-program` |
| `amount` (transact) | `value` |
| `sort` (search) | `sortBy` |
| `Authorization: Bearer <devToken>` header, `X-Finternet-Signature` | Stale. Credentials go in the body (`context.developerToken`, `context.authorization`). |
| `/v1/api-clients/*`, `fnt_…` API keys | Stale. The current API is `/v1/clients/*` with `c2Et…` SA tokens. |
| entityType `individual` / `Individual` | `PERSONAL` (or `BUSINESS`) |
| `did:web:…`, `did:key:…`, `did:nfh:…` | Deployed DIDs are `did:units:0x<hex>` |
| "toket", "allocation", "token pool" | Public-doc concepts. In code, a fungible toket is the per-(owner, class) `tokens` row. |
| "Foundry" (public docs) | dev environment. "Sanctum" is the staging integrator sandbox. |
| "NFH" | "National Financial Hub" (voucher schema) or "Network for Humanities" (NFH-T). Both expansions appear. |

---

## 9. Glossary A–Z

**A**
- **access (identity type)**: Identity stamped on tokens when a delegation activates. Grants view/transact/manage per the delegation and is excluded from the state commitment.
- **Account**: A human or legal entity with a handle (`address`), identity hash, DID, entityType and one home instance.
- **account_id**: Internal UUIDv7 primary key of a units-api `accounts` row. Not used on the wire for identity.
- **Adapter**: A service that bridges UNITS to an external ledger (chain adapter) and enables proxy mode.
- **Adapter orchestrator**: Go reverse proxy in `units-services` that routes chain-adapter calls by `context.chainId` to the top-priority active `adapter_registry` row. No retries or failover.
- **adapter_registry**: Table of chain-adapter services (`adapter_id`, `type`, `chain_ids` CAIP-2, `priority`, `active`, `config.url`).
- **additionalStateRequirements**: Class-config rule that loads other tokens (same class `SELF` or another class) into one atomic execution, for example pool + loans or voucher + credentials.
- **address**: Human-readable account handle (`^[a-z0-9._-]+$`). Plaintext in `to`, grantee, class identities and `/address/*`.
- **address hash / identity hash**: `sha256(lower(trim(address)))` hex. The stored identity, the JWT `preferred_username` and the registry primary key.
- **affectedTokenIds**: `transactions.metadata` array of tokens created or touched. One way to find the tokenId after a mint.
- **allowedOperations**: Map of scope → JSON dot-path → allowed values, which narrows what a client or delegation may send (for example only `payload.operation ∈ [transfer]`).
- **Alchemy chain adapter**: The deployed chain adapter, covering EVM chains via Alchemy plus Solana.
- **Allocation**: Public-doc term for the quantity a holder has. In code it is `state.balance`.
- **Anchoring (ledger anchor)**: Publishing a Merkle root on an external chain. **Not implemented**. `ledger_anchors` is always NULL.
- **API client**: See *Client*.
- **API id (`context.id`)**: Operation identifier such as `api.token.mint`. The server assigns the real one per route, and `scope_apis` maps it to a scope.
- **asset selector**: The plan's description of what moves (`tokenClassId`, `value`, `tokenId`, chain fields…), passed to every primitive.
- **audit_events**: Engine-written audit rows per affected token (TOKEN_MINTED…).
- **authorization (context)**: `context.authorization: "Bearer <user JWT>"`. The user session goes in the body, not in a header.
- **authToken (SSO)**: Short-lived (≤300 s) JWT minted by the web-app BFF after Google sign-in, then exchanged at `/v1/account/login`.
- **AUTO_REVERSING**: Federation status while compensations run after the point of no return.
- **awaiting_signature**: Transaction status in which a proxy transfer waits for a user-signed chain tx (`response_data.unsignedTx`).

**B**
- **BalanceModel**: Engine trait (credit, debit, lock, drain_lock, release_lock, reserve/consume/drop_incoming) with fungible and NFT implementations.
- **balanceRollup**: `{available, lockedTotal, incomingTotal, total}` summary in token state.
- **Batch (Merkle)**: A set of completed transactions hashed into one BLAKE3 tree by proofService. Produced only when full.
- **BFF**: Backend-for-frontend. The Express server inside finternet-app that holds the dev token and routes users to their home units-api.
- **BLAKE3**: Hash used for Merkle leaves and nodes, and optionally for state commitments.
- **Burn**: Transact operation that destroys units. A user burn returns units to the issuer pool, while an issuer burn reduces supply.
- **BUSINESS**: One of the two `entityType` values.

**C**
- **c2Et**: Base64 prefix of `sa-`. Every developer token starts with it.
- **CAIP-2**: Chain id standard `namespace:reference` (`eip155:1`, `eip155:8453`, `solana:mainnet`).
- **CAIP-10**: Account id on a chain (`eip155:1:0xabc…`), used for linked wallets.
- **Capability document**: Self-signed descriptor an instance publishes to the registry: ULIP versions, programs/asset models, primitive methods, templates, token classes accepted/issued, chains, signup flag, endpoints, keys.
- **CAPABILITY_DENIED**: Engine error. The program's `PrimitiveCapabilities` lacks the requested primitive (for example the voucher program has no DomainLifecycle).
- **category**: Transact field that selects the voucher category for policy-bound semi-fungible splits.
- **CERSAI**: India's Central Registry of Securitisation Asset Reconstruction and Security Interest. `cersai_registered` is a LOAN-NFT domain operation that records a lien.
- **Chain adapter**: A stateless service implementing the chain-adapter API for a set of chains.
- **chain_registry**: Per-instance table of known networks (CAIP-2 `networkId`, family, testnet flag, status). 31 chains are seeded.
- **Claim**: A VC-shaped object in `relationships[]` (@context, type, issuer, credentialSubject, proof, status). Stored, not verified.
- **Client (API client / developer client)**: A registered consumer owned by an account. It is a Keycloak `sa-<uuid>` service account with scopes, allowedOperations and a rate tier, held authoritatively in the registry.
- **clientSecret**: 32 random bytes in base64url (43 chars). Shown once at register or rotate.
- **ClickStack / HyperDX**: Observability backend that receives OpenTelemetry traces, logs and metrics.
- **co-owner**: Token identity type for joint holding.
- **CommitCredit**: Saga primitive on the destination that turns the incoming reservation into balance.
- **CommitDebit**: Saga primitive on the source that drains the lock. This is the **point of no return**.
- **Commitment (state commitment)**: Hash of selected token fields chained to the previous commitment. sha256 by default, or blake3.
- **Commitment chain**: The sequence of commitments in `state_history`, verified before each operation.
- **Compensation**: Steps that undo a partially-executed saga: `Unlock` and `RejectIncoming` before the point of no return, `Credit` back plus `RejectIncoming` after it.
- **completionTarget**: URL (units-api `/v1/internal/primitives/complete`) to which the engine POSTs a signed completion for each primitive.
- **Config**: See *Token class config*.
- **context**: Envelope metadata: `id`, `version`, `ts`, `msgId`, `developerToken`, plus optional `authorization`, `valueFormat`, `transactionId` and `debug`. `additionalProperties:false`.
- **Correlation id**: Optional `X-Correlation-ID` header, propagated through traces and Kafka messages.
- **CreateIncoming**: Saga primitive on the destination. It reserves an inbound credit backed by the source's proof-of-lock.
- **creator**: Token identity type recording who created the token.
- **Credential (program)**: `credential` program for soulbound W3C VC tokens (add, revoke, suspend, resume).
- **CREDENTIAL (class)**: Seeded credential class. KYC VCs from the web app are minted into it via `/token/add`.
- **credential-verification (hook)**: Voucher pre-hook that requires the holder to own Active credentials of the listed classes. Checks presence only.
- **credentialSubject**: The VC subject. For `/token/add` it is a closed, KYC-shaped object (`id`, `documentType`, `country`, `faceMatchVerified`, `faceMatchPercentage`…).

**D**
- **DA (Direct Assignment)**: Indian loan-portfolio transfer structure, one of the pool shapes the loan-pool program models.
- **data (token section)**: Program-defined mutable domain data. Not schema-enforced.
- **decimals**: Class metadata used to convert display amounts to raw ones (USDC 6, INR 2, NFT 0).
- **Delegation**: A grantor→grantee grant of `view`/`transact`/`manage` over a label, as allow or deny with optional expiry. Stored in the registry.
- **delegation-create / delegation-revoke**: Registered workflow names behind `/v1/workflows/execute` for creating, approving, rejecting, cancelling and revoking delegations.
- **Deny rule**: A delegation with `rule_type: deny`. It always wins over allows.
- **Developer token**: `base64("sa-<uuid>:<secret>")` in `context.developerToken`. Identifies the integrating app, and is resolved by the registry on every call.
- **DID**: Decentralized Identifier. Deployed as `did:units:0x<ed25519 pubkey hex>`.
- **did:units**: UNITS DID method, derived from the account's Ed25519 public key.
- **Display (valueFormat)**: Decimal strings scaled by class `decimals`.
- **DLQ**: Dead-letter topic `units.token.operations.dlq` for messages that exhaust retries.
- **domain_lifecycle**: Saga recipe (`domain_lifecycle@2.0`, one `DomainLifecycle` step) for mint and all non-transfer operations. Also the wrapper verb in engine messages.
- **Domain operation**: A program-specific operation such as `loan_disbursed`, `payment_received`, `dpd_bucket_updated` or `payout`.
- **DPD**: Days Past Due. Loan delinquency buckets (0, 1-30, 31-60, 61-90, 90+).
- **DvP**: Delivery versus Payment. An atomic asset+cash settle, designed but not built.

**E**
- **Ed25519**: Signature scheme for envelope signatures, ULIP, registrar records, DIDs and completion callbacks.
- **enableSignatureVerification**: units-api setting (code default true) that makes `signature` mandatory on `/token/transact`. Enforcement is environment-dependent, so always build signing in.
- **Engine**: See *Token engine*.
- **entityType**: `PERSONAL` or `BUSINESS`.
- **entry_type**: `debit` or `credit` on `token_transactions` (double-entry).
- **Envelope**: Request `{context, payload, signature?}`, response `{context, response}`. Every business call is `POST` with JSON.
- **Envelope signature**: `{keyId, jws}`, where `jws` is a std-base64 **raw Ed25519 signature** over the RFC 8785 JCS bytes of `payload`. It is not a compact JWS despite the name.
- **ERC labels**: `ERC-20`, `ERC-721`, `ERC-3643` as `tokenStandard` strings. They select a program and do not mean contract compliance.
- **evidence[].rawPayload**: Free-form area of a credential where domain data belongs (credentialSubject is closed).
- **extensions.<programId>**: The only sanctioned place for program-specific fields in mint and transact payloads.

**F**
- **Federation**: A network of UNITS instances with a central registry, home instances and ULIP messaging.
- **Finternet**: The vision and network of a federated, tokenised financial internet. UNITS is its implementation.
- **finternet (realm)**: Keycloak realm for end-user identity (user session JWTs).
- **finternet-app**: Next.js end-user web app plus Express BFF (sign-up, tokens, transfers, KYC, API Access → Clients).
- **FLDG**: First Loss Default Guarantee, a credit enhancement on loan pools (`fldg_update` operation).
- **FOIR**: Fixed Obligation to Income Ratio. Loan field; current code accepts integer strings 1–10000 (basis points), while older builds required (0,1]. `"1"` is valid on both.
- **Foundry**: The dev environment (`foundry.finternetlab.io`). It may be unavailable.
- **FORWARD (409)**: Login response when the account is homed on another instance.
- **Forwarding pointer**: Signed record pointing a migrated account to its new home instance.
- **Freeze / Unfreeze**: Compliance hold on a token (fungible). A frozen token cannot move.
- **fungible (program)**: Program for UNITS-FT, ERC-20 and ERC-3643 balances and supply.

**G**
- **gateway (Restate app)**: The units-workflows app that hosts and registers all workflows (port 9080).
- **Grantee / Grantor**: Receiver / giver of a delegation.
- **groupBy**: `/v1/token/search` option (`["tokenClass"]`) returning grouped balance sums.

**H**
- **hello-token**: Exemplar program (`UNITS-HELLO`) for program authors.
- **Home instance**: The one instance holding an account's data. The portal routes your session to it.
- **Hook**: A pre- or post-operation processor configured by `hookId`: `validation`, `logging`, `max-supply`, `min-balance`, `credential-verification`. An unknown id is silently skipped.
- **HookConfig**: `{hookId, priority (lower first), enabled, operations?}`. Its `config` is **not** passed to the hook.

**I**
- **Identities**: The `[{id, type, name?}]` list on a class or token. Ids are address hashes.
- **Identity types**: `issuer, creator, owner, co-owner, operator, viewer, access`.
- **import**: Stables operation and transaction metadata label for bringing a proxy holding in.
- **incoming (IncomingState)**: A pending inbound credit on the destination, keyed by sender `(txn_id, op_seq)`, with an expiry.
- **Instance**: One UNITS deployment (UUID, name, api_url, ulip_url, signing key).
- **IRR**: Internal Rate of Return on a loan pool (`irr_update`).
- **issuer**: Identity allowed to mint a class. Recorded on minted tokens.

**J**
- **JCS**: JSON Canonicalization Scheme (RFC 8785). Canonical bytes for envelope signatures, ULIP and NameRecords.
- **jws (field)**: Name of the signature value in `signature{keyId, jws}`. Contains a raw Ed25519 signature, not a JWS.
- **JWT (user session)**: Keycloak access token. About 10 h in practice. The refresh token idles out after 30 min and is single-use.

**K**
- **Kafka**: Internal command bus. Topics are `units.token.operations`, `.dlq` and `units.token.events` (audit). Not exposed to integrators.
- **key_references**: units-api table of account keys (ed25519/secp256k1, wallet addresses, primary/default flags).
- **keyId**: Id of the registered key used in `signature.keyId`.
- **Keycloak**: OIDC identity provider (realm `finternet` for user sessions). Not exposed to integrators.

**L**
- **Label**: Delegation resource selector (`tokens:id:<uuid>`, `tokens:tokenclass:<CLASS>`, `tokens:*`, `tokens:<jsonb>.<key>:<value>`).
- **loan-nft-program**: Loan lifecycle program (UNITS-Loan), with 22 domain operations (including `loan_originated`) plus the `mint` alias. camelCase JSON. u128 as integer strings and u32 as numbers.
- **loan-pool-nft-program**: Securitisation pool program (UNITS-LoanPool). snake_case JSON.
- **local_transfer**: Same-instance NFT transfer run as a single domain-lifecycle step.
- **Lock / Unlock**: Hold units or a token (escrow, collateral, or a saga lock keyed by `(txn_id, op_seq)`). A locked amount cannot move.
- **LockState**: `{locked, lockReason, lockedBy, lockedAt, lockedUntil, txnId, opSeq, value, category}`.

**M**
- **max-supply (hook)**: Pre-hook on mint that enforces class `metadata.maxSupply` (`MAX_SUPPLY_EXCEEDED`).
- **metadata (class)**: Class configuration bag (decimals, symbol, flags, contractIds, maxSupply…).
- **metadata (token)**: The token's identity/behaviour section (name, symbol, decimals, standard, flags, tags).
- **min-balance (hook)**: Pre-hook on transfer, burn, lock and debit that enforces `metadata.minBalance` (`MIN_BALANCE_VIOLATED`).
- **MinIO / object storage**: Object storage (local / hosted) for DID docs, credential images and large blobs.
- **Mint**: Create a token or supply via `/v1/token/mint`. Asynchronous, and does not return the tokenId.
- **MPC wallet**: Silence Labs threshold keys with passkeys, managed by the web app's wallet backend (WPBE).
- **msgId**: Fresh UUID per request attempt. Echoed back and used to trace. Not an idempotency key.

**N**
- **NameRecord**: Registrar-signed record binding address → DID → home instance (+ endpoints, contact hashes, version).
- **Native mode**: UNITS is the source of truth for the token.
- **NFH-T**: Seeded fungible class (UNITS-FT) with maxSupply/minBalance hooks, used in smoke tests.
- **non-fungible (program)**: Program for UNITS-NFT and ERC-721 unique ownership.

**O**
- **OPA / Rego**: Embedded policy engine (`rbac.rego`) for resource authorisation: owner, class manager, identity view, delegations, deny shadowing.
- **Operation**: The verb in `/v1/token/transact` (`transfer`, `burn`, `freeze`, `lock`, `update`, domain operations…).
- **operationOverrides**: Per-operation class-config settings. Stored, **not enforced**.
- **Operator account**: The single real UNITS account your organisation uses to own classes and perform platform writes.
- **operator (identity type)**: Identity acting on behalf of an owner.
- **OTel / OpenTelemetry**: Tracing, metrics and logs across all services, exported to ClickStack/HyperDX.
- **OTP**: One-time code sent by email or SMS (otp-service: Twilio Verify, SendGrid). The fixed code is `123456` in non-prod mock mode.
- **OTP JWT**: Short-lived JWT returned when a contact without an account verifies its OTP. Only valid for `/v1/account/create`.
- **Outbox (primitive outbox)**: units-api table-backed delivery of primitives to Kafka and of signals to Restate. Leased, retried and never dead-lettered.

**P**
- **participants**: `[{accountId, role: sender|receiver|operator|approver|minter}]` on token transactions.
- **payload**: The business body of the request envelope.
- **PERSONAL**: One of the two `entityType` values.
- **Plan (PrimitivePlan)**: units-api's expansion of a request into ordered primitive steps, compensations and a status policy, run by Restate.
- **planHash**: sha256 of the canonicalised plan. Re-checked by the destination to detect tampering.
- **Point of no return (PONR)**: The plan step (CommitDebit, opSeq 3) after which failures reverse instead of abort.
- **Pre-hook / Post-hook**: A pre-hook runs before `execute` and can reject. A post-hook runs after commit, and its failures are only logged.
- **Primitive**: An atomic engine step (Lock, CreateIncoming, CommitDebit, CommitCredit, Unlock, RejectIncoming, Credit, Debit, Mint, Burn, DomainLifecycle, RecordProxyEntry, Reconcile…).
- **primitive_ops**: units-api table keyed `(txn_id, op_seq)`. Gateway dedup, command outbox, engine result, completion outbox, signal outbox.
- **PrimitiveCapabilities**: A program's declaration of asset model, value mode, transferability, supported primitive methods and templates.
- **PrimitiveOperationWorkflow**: Restate workflow `primitive-operation` that drives every plan (saga with compensation).
- **profile-update**: Restate workflow for OTP-verified changes to name, email or mobile.
- **Program**: See *Token program*.
- **Proof**: A per-token commitment chain, and/or a Merkle inclusion proof from a batch (`/v1/transaction/proof|leaf|verify`).
- **proofService**: Rust batcher that writes `proofs` rows (BLAKE3 Merkle). Waits for a full batch. No anchoring.
- **PROXY-FT**: Token standard for proxied fungible chain assets (program `stables`).
- **Proxy mode**: An external ledger is the source of truth, and UNITS keeps a read-shadow via adapters.
- **proxy_record**: Saga recipe for proxy transfers (RecordProxyEntry/Debit/RecordProxyEntry/Credit). No compensation.
- **PruneTokenTransactions**: ULIP primitive that deletes prepare-phase `token_transactions` rows not yet proven, after commit.
- **PTC**: Pass-Through Certificate, an Indian securitisation structure modelled by loan pools (needs a trustee identity).

**R**
- **Raw (valueFormat)**: Base-unit integer strings.
- **Reconcile**: Proxy primitive and operation that re-syncs the shadow balance with the chain.
- **Refresh token**: Keycloak refresh token from login and create. Rotate via `/v1/account/refresh` on a timer under 30 min with a lock. Reuse returns `SESSION_REVOKED`.
- **Registrar**: The registry's signing identity (`registrar.finternet.lab`, key `registrar-key-1`). The trust anchor.
- **Registry (central)**: Federation directory and authority for names, instances, developer credentials, scopes, delegations and OIDC clients.
- **RejectIncoming**: Compensation primitive that drops an incoming reservation on the destination.
- **relationships**: Token section holding claims and dependency pointers.
- **request_log**: Registry replay-protection table keyed `(caller_instance, txn_id)`.
- **Restate**: Durable-execution runtime hosting UNITS workflows (exactly-once steps, durable promises, timers).
- **REVERSED**: Federation terminal status after a successful post-PONR reversal.
- **rotate-secret**: `/v1/clients/rotate-secret {clientId, graceSeconds}`. Issues a new secret and token, and keeps the old one valid for the grace period.

**S**
- **sa-<uuid>**: Keycloak client id of a developer service account. The left half of the developer token.
- **Sanctum**: The staging environment and integrator sandbox (`units.sanctum.finternetlab.io`). Available about 08:00–21:00 IST on weekdays.
- **Scope**: `entity:action` permission on a client (`tokens:transact`, `tokenClasses:create`…).
- **scope_apis**: Registry table mapping API id to scope key.
- **SCOPE_MAPPING_NOT_CONFIGURED**: 500 error when an API id has no scope mapping (fails closed).
- **Service account (SA)**: The machine identity behind a developer client.
- **SESSION_REVOKED**: 401 when a consumed refresh token is reused. The whole session is destroyed.
- **signature (envelope)**: See *Envelope signature*.
- **signed_lock_envelope**: Optional transact field that carries a user-signed ULIP Lock envelope for federation transfers.
- **Soulbound**: Non-transferable and non-burnable (credential tokens).
- **stables (program)**: Proxy program for PROXY-FT: import, reconcile, transfer, sign.
- **State**: The token's lifecycle section (status, balance, supply, locks, incoming…).
- **state_history**: One row per token version: snapshot, commitment, previous commitment, commitment config.
- **stateVersion**: Optimistic-lock version, +1 per write.
- **status_v2**: `transactions` column carrying the federation lifecycle (submitted/prepared/committing/committed/aborted/auto_reversing/reversed/stuck).
- **STUCK**: Federation status when the outcome after the PONR is unknown. Needs manual operations.
- **Supply**: Issuer-token `{totalSupply, circulatingSupply, usedSupply, availableSupply}`.
- **SumSub / Signzy**: KYC providers integrated in the web app. Results are minted as credential tokens.

**T**
- **Terms**: Versioned legal documents and per-user consent (`/v1/terms/get|accept|publish`).
- **TOFU**: Trust On First Use. How clients may bootstrap the registrar public key, though pinning it is preferred.
- **Token**: An instance of a token class (one `tokens` row). It holds metadata, data, identities, relationships, state and commitment.
- **Token class**: The type or definition of a token (code, standard, name, schema, issuers, metadata).
- **Token class config**: The class → program binding plus hooks and config. Mandatory.
- **Token engine**: Rust Kafka consumer (`units-token-runtime/tokenEngine`). The only writer of token state, it runs programs and hooks.
- **Token program**: Rust `TokenProgram` implementation compiled into the engine.
- **Token standard**: The `tokenStandard` string (UNITS-FT, UNITS-NFT, UNITS-SFT, UNITS-CREDENTIAL, UNITS-SBT, W3C-VC-2.0, PROXY-FT, UNITS-Loan, UNITS-LoanPool, UNITS-HELLO, ERC-20, ERC-721, ERC-3643).
- **token_transactions**: Per-token rows (double-entry) with before/after state.
- **tokenId**: UUIDv7 of a token. Find it with `/transaction/get` (`metadata.token_id`, then `metadata.affectedTokenIds`) or with search.
- **Transact**: `/v1/token/transact`, the unified write endpoint for every operation except mint and add.
- **Transaction**: An asynchronous unit of work (`txId`), tracked through `/v1/transaction/status`.
- **Trust Provider**: Public-doc actor that issues VCs (KYC, accreditation). In code, an issuer of credential tokens.
- **two_party_prepare_commit**: The transfer saga recipe (`@2.0`): Lock → CreateIncoming → CommitDebit → CommitCredit.
- **txId / txn_id**: Transaction id (camelCase in the public API, snake_case in federation APIs).

**U**
- **ULIP**: UNITS inter-instance protocol of Ed25519-signed, JCS-canonical envelopes.
- **UNITS**: Unified (or Universal) Information Tokenisation System. The ledger and token platform of Finternet, a mission of Networks for Humanity (NFH).
- **UNITS-FT / NFT / SFT**: Fungible, non-fungible and semi-fungible UNITS standards.
- **UNITS-CREDENTIAL / UNITS-SBT**: Credential and soulbound standards (program `credential`).
- **UNITS-Loan / UNITS-LoanPool**: Loan and loan-pool standards.
- **UNSUPPORTED_TOKEN_STANDARD**: Asynchronous error. The class `tokenStandard` is not whitelisted by the bound program.
- **update**: Transact operation that shallow-merges `metadata`/`data`. Needs manage permission, and has no immutability guard.
- **UUIDv7**: Time-sortable UUIDs used for most ids.

**V**
- **value**: The amount field for generic operations (string). Never `amount`.
- **valueFormat**: `context.valueFormat` set to `raw` or `display`. Send it explicitly on token get/search/mint/transact; other endpoints' closed `context` rejects it.
- **Vault (Transit)**: HashiCorp Vault, which custodies PII encryption keys and server-held Ed25519 signing keys.
- **VC (Verifiable Credential)**: W3C credential. UNITS stores VC-shaped data in credential tokens.
- **viewer**: Token identity type with view rights.
- **Voucher**: Purpose-bound, category-capped instrument (`purpose-bound-voucher`, currently not mintable).

**W**
- **wallet_provider_registry**: Allow-list of wallet apps (EIP-6963 rdns).
- **Workflow**: Restate durable process. Generic API `/v1/workflows/execute|status|cancel`.
- **workflow_ops**: Per-primitive audit rows (`txn_id`, `op_seq`, `op_type`, request/response hashes).
- **workflow_registry**: Table of registered workflows (name, version, steps, JSON schema, Restate service).
- **workflows (table)**: One row per workflow run (`txn_id`, status, payload, initiator, outcome).
- **WPBE**: Wallet Provider Backend Engine (Silence Labs MPC backend) used by the web app.

**X**
- **X-Correlation-ID**: The only HTTP header units-api reads, and it is optional.

**Y**
- **YugabyteDB**: Postgres-compatible distributed SQL used in hosted environments. Local development uses Postgres.
