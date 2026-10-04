# Token classes and token class configs

How to define *what* a token is (token class), *how* the engine treats it (token class config), and which *program* runs it. The file covers the mental model, every field, every hook and config key, a decision guide, seven complete worked examples, the 27 seeded classes, how to update and read classes, and common mistakes.

> Snapshot: **2026-10-03**. Sources: units-api HEAD (Go), units-token-runtime (Rust), seed SQL, and a live integration against sanctum (Aug 2026). The precedence when sources disagree is: live behaviour, then current code, then specs, then public docs. Where live and code differ, this file says **environment-dependent**. Things change, so verify on your instance with `POST /v1/tokenclassconfig/get` and `POST /v1/tokenprogram/search`.
>
> Companion: `token-programs.md` covers every operation and payload for each program.

---

## 1. Mental model

### 1.1 The four things

| Thing | What it is | Analogy | Who creates it | Where it lives |
|---|---|---|---|---|
| **Token class** | The *type* of a token: its key (`ACME-PTS`), standard, display info, decimals, policy flags and who may mint it | A **product definition** in a catalogue, or a class declaration in code | You (an integrator), with `POST /v1/tokenclass/register` | `token_classes` table |
| **Token class config** | The *wiring* that binds one class to one program, plus engine settings: hooks, commitment algorithm, cross-token lookups | The **settings sheet** that says "this product is made on machine X, with these checks switched on" | You, with `POST /v1/tokenclassconfig/register` (one per class) | `token_class_configs` table |
| **Token program** | Rust code inside the token engine that defines which operations exist, what their payloads look like, and how state changes | The **machine** on the factory floor. You choose one; you can't install your own | Finternet engineering, compiled into the engine | engine binary; self-registered into `token_programs` |
| **Token** | One *instance* of a class: a balance, a loan, a credential or an NFT, with owner, data, state and a hash-chained commitment | One **item** off the production line (or one account in a ledger) | `POST /v1/token/mint`, `/v1/token/add` | `tokens` table |

A simpler way to put it: **the class says what it is, the config says how it runs, the program is the rules, and the token is the thing.**

### 1.2 How they bind

```
            you register                          you register                          Finternet ships
 ┌──────────────────────────────┐     ┌────────────────────────────────────┐     ┌──────────────────────────────┐
 │ TOKEN CLASS  (token_classes) │     │ TOKEN CLASS CONFIG                 │     │ TOKEN PROGRAM (Rust, engine) │
 │  id          019a…  (uuid) ◄─┼─────┼─ tokenClassId                      │     │  programId  "fungible"       │
 │  tokenClass  "ACME-PTS"    ◄─┼─────┼─ tokenClass   (UNIQUE: 1 per class)│     │  standards  [UNITS-FT,…]     │
 │  tokenStandard "UNITS-FT" ───┼──┐  │  programId "fungible" ─────────────┼────►│  operations [mint,burn,…]    │
 │  name, description, schema   │  │  │  preHooks / postHooks              │     │  capabilities (primitives)   │
 │  identities (who may mint)   │  │  │  config  (commitment, lookups,…)   │     │  validate() / execute()      │
 │  metadata (decimals, flags…) │  │  │  operationOverrides (stored only)  │     └──────────────┬───────────────┘
 └──────────────▲───────────────┘  │  │  identities (copied from class)    │                    │
                │                  │  └────────────────────────────────────┘                    │
                │                  └── must be in the program's supportedStandards ──────────────┤ (exact match,
                │ tokenClass + token_class_id                                                    │  else UNSUPPORTED_
 ┌──────────────┴───────────────┐        /v1/token/mint  /v1/token/add  /v1/token/transact      │  TOKEN_STANDARD)
 │ TOKEN (tokens)               │◄──────────────────── executed by the program ─────────────────┘
 │  id, tokenClass, identities, │
 │  metadata, data, state,      │
 │  relationships, commitment   │
 └──────────────────────────────┘
```

Rules that follow from this picture:

1. A class **without a config is unusable**: every operation fails with `400 INVALID_INPUT: primitive_capability_missing`.
2. **One config per class.** A second `register` returns `409 CONFLICT`. Change it with `/v1/tokenclassconfig/update`.
3. The class's `tokenStandard` must **exactly match** one of the program's standards. A mismatch isn't caught at registration. It fails later, at poll time, with `UNSUPPORTED_TOKEN_STANDARD`.
4. Tokens point at the class by name (`tokenClass`) and by id (`token_class_id`, taken from the config's `tokenClassId`).
5. The program is chosen per class, not per token. Every token of `ACME-PTS` runs on `fungible`.

### 1.3 Setup lifecycle

```
operator account (OTP login → user JWT)
   │
   ├─1─ POST /v1/tokenclass/register        (sync, 201) → response.id = tokenClassId
   ├─2─ POST /v1/tokenclassconfig/register  (sync, 201) → binds programId
   ├─3─ POST /v1/token/mint | /v1/token/add (async)     → {txId, status:"submitted"}
   ├─4─ POST /v1/transaction/status {txId}  (poll)      → completed | failed (+error)
   └─5─ POST /v1/transaction/get {txId}                 → metadata.token_id
```

Steps 1 and 2 are **synchronous** and need no polling. Make them idempotent: call `.../get` first and register only if the get returns 404 (see §9.6).

---

## 2. Token class fields (`POST /v1/tokenclass/register`)

`context.id`: `api.tokenclass.register` (alias path `/v1/registry/tokenclasses/register`, id `api.registry.tokenclasses.register`). Scope: `tokenClasses:create`. Auth: developer token plus the operator's user JWT. The route is "federated", so a dev-token-only call stamps the client's registered owner instead, but **always send the operator JWT** so that a real account owns the class.

The payload schema is **open** (`additionalProperties: true`). Unknown keys are silently ignored and not stored. `chainDeployments` and `status`, which appear in some OpenAPI examples, are ignored on register.

| Field | Type | Req | Meaning | Server behaviour |
|---|---|---|---|---|
| `tokenClass` | string | **yes** | The class key used everywhere (mint, add, search, config). | **Upper-cased** before storage and on every lookup (`acme-pts` becomes `ACME-PTS`). There's no pattern check, but the DB lookup is case-sensitive *after* upper-casing, so keep keys upper-case ASCII: `^[A-Z0-9][A-Z0-9-]*$`. Must be unique on the instance, else `409 CONFLICT "Token class already exists"`. |
| `tokenStandard` | string | **yes** | Picks the token family. Must be on the target program's whitelist (§6). | Stored verbatim and **not validated** at register. The API upper-cases it only for its own routing gates. The engine does an **exact, case-sensitive** comparison against the program's list, so use exactly `UNITS-FT`, `UNITS-NFT`, `UNITS-CREDENTIAL`, `UNITS-SFT`, `PROXY-FT`, `UNITS-Loan`, `UNITS-LoanPool`. |
| `name` | string | **yes** | Display name. | Stored. |
| `description` | string | no | Display text. | Stored. |
| `schema` | object | **yes** | A JSON Schema describing the token's `data`. | Stored as JSONB and **NOT enforced**. Mint and transact never validate against it (the validator was removed). Programs are the real validators. Treat it as documentation for humans and for your own client-side validation. `{"type":"object"}` is accepted. |
| `identities` | array of `{id, type, roles?, name?}` | no | Who has which role *on the class*. `type:"issuer"` means "may mint". | Each `id` is **SHA-256 hashed** (`sha256(lower(trim(id)))`) unless it already looks like a 64-hex hash. So pass **plaintext addresses** (e.g. `"acme-ops"`), not DIDs. **If omitted *or* `[]`**, the server stamps the caller as `owner` **and** `issuer` (with the caller's name). |
| `metadata` | object | no | Free-form policy and display data. Some keys are read by code (§2.2). | Stored as-is (JSONB). On update it is **fully replaced**, not merged. |

**Response: `201`**, with `context.status:"successful"`:

```json
{
  "context": {"id":"api.tokenclass.register","version":"1.0","ts":"2026-10-03T10:00:00Z","msgId":"…","status":"successful"},
  "response": {
    "id": "019a3c1e-7b2a-7c41-9f0e-2d5b8a1c4e77",
    "tokenClass": "ACME-PTS",
    "tokenStandard": "UNITS-FT",
    "name": "ACME Loyalty Points",
    "description": "…",
    "schema": { "…": "…" },
    "identities": [
      {"id": "<sha256 of operator address>", "type": "owner",  "name": "Acme Ops"},
      {"id": "<sha256 of operator address>", "type": "issuer", "name": "Acme Ops"}
    ],
    "metadata": { "…": "…" },
    "status": "active",
    "createdAt": "2026-10-03T10:00:00Z",
    "updatedAt": "2026-10-03T10:00:00Z"
  }
}
```

**Save `response.id`.** That is the `tokenClassId` the config needs.

### 2.1 Class identities: ownership and minting rights

| Stored class `identities` | Who may mint (`/v1/token/mint`) | Who may manage (update class/config) |
|---|---|---|
| Stamped by default `[owner=caller, issuer=caller]` | Only the caller (registering account) | The caller, plus anyone holding a `manage` delegation on the class |
| Explicit list, e.g. `[{"id":"acme-ops","type":"issuer"},{"id":"acme-ops","type":"owner"}]` | Accounts with an `issuer` entry (matched against the caller's address hash; the type match is case-insensitive) | Accounts with an `owner` entry, or delegations |
| `[]` stored (seeded `NFH-T`, `CREDENTIAL`, `SODEXO-MV`, all PROXY-FT) | **Any authenticated user** | Platform only |

Notes:
- You **can't create an open (`[]`) class through register**, because an empty list is treated like an omitted one and stamps you. You *can* open one afterwards with `/v1/tokenclass/update {"tokenClass":"X","identities":[]}`. The update path stores `[]`, but **that also removes your own manage rights**, so think twice before doing it.
- Class identities gate **`/v1/token/mint`**. `/v1/token/add` (credential or proxy import) is a developer-token-only, sessionless issuance path; verifiers should validate credential provenance (expected token class, VC `issuer`, provider signature/evidence, and confirmation from the issuing provider) rather than relying on class membership alone (`token-programs.md` §6.3).
- If you list explicit identities, **include an `owner` entry for yourself**. Otherwise nobody can update the class except through delegations.
- The class identities are **copied into the config** when the config is registered. A later class `update` that changes identities propagates them to the config.
- `metadata.allowedMinters` (seen on LOAN-NFT and LOAN-POOL) is **informational**. No code reads it. Only `identities[type=issuer]` gates minting.

### 2.2 Metadata keys: what is actually read

| Key | Type | Read by | Effect |
|---|---|---|---|
| `decimals` | int | **units-api** | Converts `display` to `raw` for `initialSupply`, `value` and voucher `redemptions`, and scales amounts in reads when `valueFormat:"display"`. Absent means 0. Also read by the `max-supply` and `min-balance` hooks to format error messages. |
| `fungible` | bool | **engine** | `true` (or absent!) makes the engine look up the existing *per-owner* token on mint (so supply is added to the same token). `false` creates a new token per mint. **Set `false` explicitly for NFT, credential, loan and pool classes.** |
| `maxSupply` | string, raw base units | **`max-supply` hook** | Caps total supply on `mint` (only if the hook is in `preHooks`). |
| `minBalance` | string, raw base units | **`min-balance` hook** | Minimum balance that must remain after `transfer`, `burn`, `lock` or `debit` (only if the hook is configured). |
| `contractIds` | object `{CAIP-2 chainId: contract/mint address}` | **units-api** | PROXY-FT only. `/v1/token/add` requires `contractAddress == contractIds[chainId]` (case-insensitive), else `400 "contractAddress does not match registered contract for X on Y"`. Also used to discover holdings when a wallet key is registered. |
| `transferable` | bool | **units-api** (vouchers) and **voucher program** | For UNITS-SFT, transfer requires `metadata.transferable:true` **and** config `voucherTransfer.enabled:true`. For other standards this key is informational. |
| `redeemableCategories` | string[] | **voucher program** | Allowed categories in `categoryLimits`, `redeem` and `lock`. |
| `maxGreetingLength` | string (number) | hello-token only | Example program setting. |
| `symbol`, `category`, `divisible`, `burnable`, `revocable`, `soulbound`, `proxyFor`, `valuation{parValue,currency,region,compliance}`, `valueCurrency`, `escrowCurrency`, `allowedMinters`, `defaultValidityDays`, `tags` | various | nobody (informational) | Shown in `tokenClassInfo` on every token read. Use them for your UI and documentation. **They do not enforce anything.** For example, `burnable:false` does not stop a burn, and `soulbound:true` does not stop a transfer (the *program* and the API standard gate do). |
| `class_manager_operations`, `class_user_operations` | string[] | OPA input (optional) | Authorisation extension hooks; not populated on the token path today. |

### 2.3 Class `status`

The status is `active` on register. Only `active` classes are found by lookups. `/v1/tokenclass/update {"status":"inactive"}` effectively hides the class (mints fail with "Token class not found").

---

## 3. Token class config fields (`POST /v1/tokenclassconfig/register`)

`context.id`: `api.tokenclassconfig.register`. Scope: `tokenClassConfigs:create`. Auth: developer token plus user JWT (required).

| Field | Type | Req | Meaning | Server behaviour |
|---|---|---|---|---|
| `tokenClass` | string | **yes** | Class key. | Upper-cased. UNIQUE, so a second register gives `409 CONFLICT`. |
| `tokenClassId` | uuid string | **yes** | `response.id` from class register. | Must parse as a UUID (`400 "invalid token_class_id format"`). **Not cross-checked** against `tokenClass`, so a wrong id silently mis-links tokens. Copy it carefully. |
| `programId` | string | **yes** | Which program runs the class: `fungible`, `non-fungible`, `credential`, `stables`, `purpose-bound-voucher`, `loan-nft-program`, `loan-pool-nft-program`. | **Not validated at register.** A typo (e.g. `loan-nft` or `reference-ft`) fails on the first operation with `400 primitive_capability_missing`. |
| `preHooks` | array of hook objects | no | Configurable hooks that run **before** the program executes. They can block the operation. | Stored. Send `[]` if you don't want any. |
| `postHooks` | array of hook objects | no | Hooks that run **after** the state is committed. They can't block or roll back. | Stored. |
| `operationOverrides` | object | no | `{"<op>": {"disabled": true, "reason": "..."}}` | **Stored but NOT enforced** by the engine today. It is documentation only. |
| `config` | object | no | Engine and program settings (§3.3). | Stored. Unknown keys are ignored. |

There is also a server-side `identities` field, which is copied from the parent class (or stamped with the caller as owner if the class has none). Configs also have a `status` (`active` on register). The engine only reads `status='active'` configs. Setting `"status":"suspended"` stops all operations on the class (`CONFIG_NOT_FOUND`, async).

**Response: `201`**:

```json
{
  "context": {"id":"api.tokenclassconfig.register","version":"1.0","ts":"…","msgId":"…","status":"successful"},
  "response": {
    "id": "019a3c1f-0d44-7a90-8b1e-5c2f7d9e1a03",
    "tokenClass": "ACME-PTS",
    "tokenClassId": "019a3c1e-7b2a-7c41-9f0e-2d5b8a1c4e77",
    "programId": "fungible",
    "preHooks": [ "…" ],
    "postHooks": [ "…" ],
    "operationOverrides": {},
    "config": { "…": "…" },
    "identities": [ "…copied from class…" ],
    "status": "active",
    "createdAt": "…", "updatedAt": "…"
  }
}
```

> **Code caveat:** config register doesn't check that the caller owns the class, and doesn't check that the program exists. Register your config **immediately** after the class, and confirm with `tokenclassconfig/get`.

### 3.1 Hook object format

```json
{"hookId": "max-supply", "priority": 5, "enabled": true, "operations": ["mint"]}
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `hookId` | string | required | One of the registered ids in §3.2. **An unknown id is skipped silently** (with a warning in engine logs). Typos therefore disable your check without any error. |
| `priority` | int | 0 | **Lower runs first.** Ordering uses this value, not the hook's built-in priority. |
| `enabled` | bool | true | `false` skips the hook. |
| `operations` | string[] | all ops | Restricts the hook to these operations. Names are normalised (case, `-`, space and camelCase all become snake_case lowercase), so `"Mint"`, `"mint"` and `"MINT"` all match. They match the **inner** operation name (e.g. `issue`, `loan_disbursed`), never `domain_lifecycle`. |
| `config` | object | none | Accepted and stored, but **never passed to the hook**. Hooks read class `metadata` or config `config` instead (see each hook). |

Pre-hook semantics: if the hook returns an error, `Fail` or `Skip`, the operation **fails** with `HOOK_FAILED` (or a mapped code, see below). Post-hooks never fail the operation, because the state is already committed.

### 3.2 Hook catalogue (every configurable hook)

| hookId | Phase | Operations it acts on | Reads | What it does | Failure code (in `/transaction/status` → `error.code`) |
|---|---|---|---|---|---|
| `validation` | pre (post: warns only) | skips `mint`. Checks `transfer`, `burn` and `unfreeze` | token state and identities | `transfer`/`burn`: the token must be `active` with no spend-blocking lock, and the initiator must be the owner, **or** hold an identity on the token with `type:"access"` or roles containing `operator`/`admin`. `unfreeze`: the token must be `frozen`. | `INVALID_TOKEN_STATUS`, `TOKEN_LOCKED`, `UNAUTHORIZED` (via `HOOK_FAILED` wrapping) |
| `logging` | pre and post | all | — | Structured logs (`operation_starting`, `operation_completed`). Never fails. Harmless to include. | — |
| `max-supply` | pre | `mint` (it only checks mint even if configured wider) | class **metadata** `maxSupply` (raw string), `decimals` | If `maxSupply` is set: `currentTotalSupply + initialSupply > maxSupply` fails, with a message like "Mint of X would exceed maximum supply M. Current supply: C, remaining capacity: R." No `maxSupply` means it passes. | `MAX_SUPPLY_EXCEEDED` |
| `min-balance` | pre | `transfer`, `burn`, `lock`, `debit` | class **metadata** `minBalance` (raw string), `decimals` | If `minBalance` is set: `spendable − value < minBalance` fails. **The payload must carry `value`.** A burn-all (no `value`) or a whole-token lock (no `value`) fails with `INVALID_PAYLOAD "Could not determine operation value for minBalance check"`. Because transfers execute as a `lock` step, **include `"lock"`** in `operations` or transfers aren't checked. | `MIN_BALANCE_VIOLATED` |
| `credential-verification` | pre | `issue` (voucher program) | config `credentialVerification.requiredCredentials`, `credentialVerification.additionalStatesKey` (default `beneficiary_credentials`), plus the tokens loaded by `additionalStateRequirements` | For each required string, at least one loaded token with state `active` must have `data.type` **equal to that string**. **Caveat (code-verified):** it compares `data.type` as a *plain string*. A standard W3C VC has `type` as an *array* (`["VerifiableCredential","KYCCredential"]`), so real VCs never match. It is a presence check only, with no signature or expiry verification. | `HOOK_FAILED` ("Beneficiary missing required credential: X") |

Hook ids that appear in seeds or docs but **do not exist** (they are silently skipped): `audit` (the CREDENTIAL seed's post-hook; auditing is mandatory anyway), `audit-log`, `rate-limiter`, `issuer-check`, `escrow-transfer`.

**Mandatory engine hooks** (always on, and not configurable):
1. **Commitment verification.** Before any operation on an existing token, the engine recomputes its state commitment and compares it with the stored one. A mismatch gives `DATA_INTEGRITY_VIOLATION`.
2. **Envelope verification.** Federation `create_incoming`/`commit_credit` proofs are checked (Ed25519 when the instance has a peer key configured).
3. **Audit log.** An `audit_events` row is written per affected token.

### 3.3 `config` keys

| Key | Type | Default | Read by | Meaning |
|---|---|---|---|---|
| `stateCommitmentAlgorithm` | `"sha256"` \| `"blake3"` | `sha256` | engine and all programs (pool uses the default) | Hash algorithm for the per-token chained state commitment. Unknown values fall back to sha256. |
| `stateCommitmentFields` | string[] | `[]` = all fields | engine and programs | The subset of `previous_commitment, last_tx_id, timestamp, token_id, owner, identities, relationships, state, state_version, data` to hash. An explicit list **excludes anything you don't list**. For example, the NFH-T seed omits `data`, `identities` and `relationships`. Leave it empty unless you have a reason. |
| `includeDataInCommitment` | bool | — | **nobody** (ignored) | Seen in seeds. It isn't a real key: data is hashed anyway when `stateCommitmentFields` is empty. Harmless. |
| `includeRelationshipsInCommitment` | bool | — | **nobody** (ignored) | Same as above. |
| `enableStateHistory` | bool | true | parsed, unused | — |
| `additionalStateRequirements` | array (§3.4) | none | **engine** | Pre-loads *other* tokens into the program's context for selected operations (cross-token rules). |
| `credentialVerification` | `{requiredCredentials: string[], additionalStatesKey: string}` | none | `credential-verification` hook | See §3.2. |
| `voucherTransfer` | `{enabled: bool}` | false | units-api and voucher program | Voucher (UNITS-SFT) transfer gate. Transfer also needs class `metadata.transferable:true`. |
| `defaultValidityDays` | int | — | **nobody** (informational) | On the CREDENTIAL seed; the credential program doesn't read it. Set `validUntil` in the VC yourself. |
| any other key | — | — | programs, if they choose to | Programs can read `config.<key>` through `get_config_value`. None of today's programs read keys beyond those listed here. |

Changing commitment settings later **does not break existing tokens**. Each state-history row stores the commitment config that was used, and verification uses that historical config.

### 3.4 `additionalStateRequirements`: cross-token rules

This tells the engine: *"for these operations, also load these other tokens and hand them to the program and hooks under this key."* Every loaded token is also **commitment-verified**, so a tampered dependency fails the operation.

```json
{
  "key": "beneficiary_credentials",
  "tokenClass": "CREDENTIAL",
  "ownerFrom": "payload.to",
  "operations": ["issue"],
  "multiple": true,
  "filters": null
}
```

| Field | Type | Meaning |
|---|---|---|
| `key` | string | The name under which the program or hook finds the loaded state (e.g. `issuer`, `recipient`, `loan_tokens`, `beneficiary_credentials`). Programs look for specific keys (see the table below). |
| `tokenClass` | string | `"SELF"` means the operation's own class. Otherwise give a literal class key (`"CREDENTIAL"`, `"ACME-LOAN"`). |
| `ownerFrom` | string | Load the token(s) **owned by**: `"initiator"` (the caller), `"payload.<field>"` (a *top-level* field of the resolved operation payload, e.g. `payload.to`), or `"identity.<type>"` (the message identity of that type). |
| `tokenIdsFrom` | string (optional) | `"payload.<dot.path>"` to an **array of token UUIDs**. This takes precedence over `ownerFrom`. A missing path means the requirement is **silently skipped**. A non-array gives `INVALID_PAYLOAD`. |
| `operations` | string[] | Only for these (inner) operations. Empty means all operations. |
| `multiple` | bool | `false`: load one token (the oldest match). `true`: load all matches into a container whose `data` is a JSON array of token states. |
| `filters` | object | Accepted but **ignored** (reserved for phase 2). |

Which keys today's code consumes:

| Program or hook | Key it reads | Purpose |
|---|---|---|
| `fungible` burn | `issuer` (multiple:false, tokenClass:"SELF") | On a *user* burn, credits the burned amount back to the issuer's reserve. **No seed defines it.** Without it, a user burn debits the user and the issuer reserve is not credited (a warning only). |
| `credential-verification` hook | `config.credentialVerification.additionalStatesKey` (default `beneficiary_credentials`) | Credentials the voucher beneficiary must hold. |
| `loan-pool-nft-program` mint | `loan_tokens` (multiple:true, via `tokenIdsFrom`) | Verifies that the referenced loans exist and writes `LoanPoolMembership` claims onto each loan in the same DB transaction. |
| (none) | `recipient` (NFH-T seed), `redeemer_credentials` (SODEXO-MV seed) | Loaded but **no code consumes them**. They are dead entries. |

Examples:

```json
// Credit burns back to the issuer token (fungible). ownerFrom form is code-supported; not live-tested.
{"key":"issuer","tokenClass":"SELF","ownerFrom":"identity.issuer","operations":["burn"],"multiple":false}

// Voucher issue: load every CREDENTIAL token owned by the recipient.
{"key":"beneficiary_credentials","tokenClass":"CREDENTIAL","ownerFrom":"payload.to","operations":["issue"],"multiple":true}

// Loan pool mint: load the loans listed in the mint data.
{"key":"loan_tokens","tokenClass":"ACME-LOAN","tokenIdsFrom":"payload.data.loan_token_ids","operations":["mint"],"multiple":true}
```

> **Pool path caveat (unverified):** after the engine unwraps a create operation, the pool's fields sit under `payload.data`, so the seed path `payload.loan_token_ids` probably resolves to nothing. The requirement is then skipped: the pool still mints, but no membership claims are written to the loans and the "loans exist" check doesn't run. `payload.data.loan_token_ids` is the likely correct path. Confirm with Finternet before relying on loan-side claims.

### 3.5 `operationOverrides`

```json
{"transfer": {"disabled": true, "reason": "Soulbound tokens cannot be transferred"},
 "burn":     {"disabled": true, "reason": "Credentials cannot be burned"}}
```

These are stored and returned, but **not enforced** by the engine. What actually blocks operations is:
- The **program** (e.g. `credential` has no `transfer` or `burn`, so you get `UNSUPPORTED_OPERATION`, or `operation_not_supported` at the API).
- The **API transfer gate by standard**. Transfers are refused for credential, `UNITS-Loan` and `UNITS-LoanPool` standards (`400 "federation transfer is not supported by this token program capability"`).
- Delegations with `deny` rules, and SA `allowedOperations`.

Write overrides anyway, as documentation. Never rely on them for safety.

---

## 4. Choosing `tokenStandard` and `programId`

### 4.1 Program × standard whitelist

| programId | Accepted `tokenStandard` (exact) | Asset model | Create via | Live status (Aug–Oct 2026) |
|---|---|---|---|---|
| `fungible` | `UNITS-FT`, `ERC-20`, `ERC-3643` | per-owner balance and issuer supply | `/token/mint` | mint works. **Cross-account `transfer` returned `recipient_address_not_found` on sanctum** (open issue) |
| `non-fungible` | `UNITS-NFT`, `ERC-721` | unique ownership, balance "1" | `/token/mint` (`initialSupply:"1"`) | in code; not discoverable on sanctum in Aug 2026 (environment-dependent) |
| `credential` | `UNITS-CREDENTIAL`, `UNITS-SBT`, `W3C-VC-2.0` | soulbound W3C VC | `/token/add` | **works live** |
| `stables` | `PROXY-FT` | shadow of an on-chain balance | `/token/add` (chain fields) | works for seeded classes; needs the chain adapter |
| `purpose-bound-voucher` | `UNITS-SFT` | semi-fungible, category-capped | `/token/mint` | **BLOCKED**: `CAPABILITY_DENIED` on mint, issue, redeem and revoke |
| `loan-nft-program` | `UNITS-Loan` (also `UNITS-NFT`, `UNITS-LOAN`) | one token per loan, 22 lifecycle operations (plus the `mint` alias) | `/token/mint` (= `loan_originated`) | **works live** |
| `loan-pool-nft-program` | `UNITS-LoanPool` (also `UNITS-NFT`, `UNITS-LOANPOOL`) | one token per securitisation pool | `/token/mint` | in code; not exercised live |
| `hello-token` | `UNITS-HELLO` | example only | — | onboarding exemplar for program authors |

> Prefer the **first** standard listed for each program. For loan and pool classes, `UNITS-Loan`/`UNITS-LoanPool` is what the API's own gates recognise (`UNITS-NFT` would make the API treat a loan like a transferable NFT). Old names you might see in docs: `reference-ft` is now `fungible`, `reference-nft` is `non-fungible`, `reference-credential` is `credential`, `nfh-voucher` is `purpose-bound-voucher`, and `loan-nft` is `loan-nft-program`.

### 4.2 Decision guide

| You need… | tokenStandard | programId | Key class metadata | Notes and what's blocked |
|---|---|---|---|---|
| **Loyalty points / reward credits** (ACME-PTS) | `UNITS-FT` | `fungible` | `decimals`, `maxSupply`, `minBalance`, `fungible:true` | Mint to your treasury (operator). Distributing to users needs `transfer`, which failed on sanctum. Plan for that (§7.1). |
| **Fungible deposit / escrow / settlement units** (tokenised INR, gram of gold, kWh) | `UNITS-FT` | `fungible` | `decimals`, `valuation` | Use `lock`/`unlock` for escrow holds and `freeze` for compliance holds. Burn on redemption. |
| **Stablecoin you hold on-chain** (USDC on Base) | `PROXY-FT` | `stables` | `contractIds{chainId: address}`, `decimals` | **Use the seeded `USDC`/`USDT`/… classes first.** They are open (`identities:[]`). Register your own only for a token or chain that isn't listed (§7.5). |
| **Unique asset** (deed, invoice, warehouse receipt, art) | `UNITS-NFT` | `non-fungible` | `fungible:false`, `decimals` 0 | mint, burn and transfer only. No domain operations (liens, valuation updates). If you need lifecycle operations, ask Finternet for a program. |
| **KYC / attestation / licence, non-transferable** | `UNITS-CREDENTIAL` | `credential` | `fungible:false`, `soulbound:true` | Issue with `/token/add` (no user JWT). Revoke, suspend and resume need the holder's session or a delegation; verifiers should validate provenance (`token-programs.md` §6.3). |
| **Loan account** (one token per loan) | `UNITS-Loan` | `loan-nft-program` | `fungible:false`, `valueCurrency` | Register **your own** class. The seeded `LOAN-NFT` is minted only by `realassets-admin`. A lien is modelled as `cersai_registered`. |
| **Loan pool / PTC / DA securitisation** | `UNITS-LoanPool` | `loan-pool-nft-program` | `fungible:false` | Pool fields are **snake_case**. Point `additionalStateRequirements` at *your* loan class. |
| **Purpose-bound voucher** (meal card, input-subsidy voucher with category caps) | `UNITS-SFT` | `purpose-bound-voucher` | `redeemableCategories`, `decimals`, `transferable` | **Blocked today.** The common workaround is a `UNITS-FT` class per voucher programme, with category rules enforced in your app (§7.6). |
| **Lien-carrying asset, bond, invoice-finance lifecycle** | — | — | — | **No program.** Use `cersai_registered` on a loan token for a lien, or request a custom program (§10). |

---

## 5. Request context used in all examples

Every call is `POST <BASE>/v1/...` with `Content-Type: application/json`. `BASE` is e.g. `https://units.sanctum.finternetlab.io`.

```json
"context": {
  "id": "api.<group>.<action>",
  "version": "1.0",
  "ts": "2026-10-03T10:00:00Z",
  "msgId": "<fresh UUID per attempt>",
  "developerToken": "<DEV_TOKEN>",
  "authorization": "Bearer <OPERATOR_JWT>",
  "valueFormat": "raw"
}
```

- `<DEV_TOKEN>` = `base64("sa-<clientUuid>:<clientSecret>")`. Keep it server-side.
- `<OPERATOR_JWT>` = the access token of your organisation's operator account (OTP login).
- `valueFormat` is accepted only on token get/search/mint/transact. **Always send it there** (the code default is `display`), and **omit it on every other call** (e.g. class/config register), whose closed `context` rejects it.
- `context` rejects unknown keys (`400 INVALID_INPUT`).

---

## 6. Worked examples

Each example is complete and in the order you run it. Placeholders: `<DEV_TOKEN>`, `<OPERATOR_JWT>`, `<USER_JWT>`, `<TOKEN_CLASS_ID>` (from step 1's `response.id`), `<TX_ID>` (from the write call).

### 6.1 Common tail: poll and resolve the tokenId

```json
POST /v1/transaction/status
{"context":{"id":"api.transaction.status","version":"1.0","ts":"…","msgId":"…","developerToken":"<DEV_TOKEN>","authorization":"Bearer <OPERATOR_JWT>"},
 "payload":{"txId":"<TX_ID>"}}
```
Poll every 1 s with backoff until `response.status` is `completed`, `failed` or `cancelled`:
```json
{"context":{"…":"…","status":"successful"},
 "response":{"txId":"0199…","status":"completed",
             "timestamps":{"submitted":"…","started":"…","completed":"…"}}}
```
On failure: `"status":"failed","error":{"code":"UNSUPPORTED_TOKEN_STANDARD","message":"…"}`.

Then resolve the new token id:
```json
POST /v1/transaction/get   payload: {"txId":"<TX_ID>"}
→ response.metadata.token_id  →  response.metadata.affectedTokenIds[0]  →  response.responseData.tokenId | .id (legacy)
```
Read them in that order (see `api-reference.md` §5.5.2 for why).
Fallback, which takes the newest token of the class that you can see:
```json
POST /v1/token/search
payload: {"filters":{"tokenClass":"ACME-PTS"},"pagination":{"limit":1,"offset":0},"sortBy":{"field":"createdAt","order":"desc"}}
```

---

### 6.2 (a) Fungible loyalty points `ACME-PTS` with max-supply and min-balance

**Step 1: register the class**

```json
POST /v1/tokenclass/register
{
  "context": {"id":"api.tokenclass.register","version":"1.0","ts":"2026-10-03T10:00:00Z","msgId":"1d0c6a52-2c1e-4c55-9a1b-3f0e2b7c9d11",
              "developerToken":"<DEV_TOKEN>","authorization":"Bearer <OPERATOR_JWT>"},
  "payload": {
    "tokenClass": "ACME-PTS",
    "tokenStandard": "UNITS-FT",
    "name": "ACME Loyalty Points",
    "description": "Loyalty points earned on ACME purchases. 1 point = 0.01 INR. Max 10 crore points.",
    "schema": {
      "type": "object",
      "properties": {
        "programme": {"type": "string"},
        "tier":      {"type": "string", "enum": ["silver", "gold", "platinum"]}
      }
    },
    "metadata": {
      "decimals": 2,
      "symbol": "APTS",
      "fungible": true,
      "category": "utility",
      "transferable": true,
      "divisible": true,
      "burnable": true,
      "revocable": false,
      "soulbound": false,
      "maxSupply": "10000000000",
      "minBalance": "0",
      "valuation": {"parValue": "0.01", "currency": "INR", "region": "IN", "compliance": null}
    }
  }
}
```
Notes:
- `identities` is omitted, so the operator is stamped as owner and issuer.
- `maxSupply` and `minBalance` are **raw base units**. With `decimals:2`, `"10000000000"` means 100,000,000.00 points. Set `minBalance` above `"0"` only if you really want holders to keep a floor (e.g. `"10000"` = 100.00).
- `maxSupply` is checked against the `totalSupply` of the **minting account's own token**, so it's a per-issuer cap. With you as the only issuer, it's the class cap (`token-programs.md` §4).
- The floor applies to **every holder's token, your treasury included**, on transfer, burn, lock and debit. There are no per-holder floors and no exemptions.
- **Any `minBalance` value, even `"0"`, makes `value` mandatory** on every op the `min-balance` hook covers. A whole-balance burn or a whole-token lock (no `value`) then fails with `INVALID_PAYLOAD "Could not determine operation value for minBalance check"`. If you don't want a floor, leave `minBalance` out entirely.

Response `201`: `response.id` = `<TOKEN_CLASS_ID>` (shape as in §2).

**Step 2: register the config**

```json
POST /v1/tokenclassconfig/register
{
  "context": {"id":"api.tokenclassconfig.register","version":"1.0","ts":"2026-10-03T10:00:05Z","msgId":"4b2f0a8e-6a3d-4f1e-8c77-0b9d2e4a6f21",
              "developerToken":"<DEV_TOKEN>","authorization":"Bearer <OPERATOR_JWT>"},
  "payload": {
    "tokenClass": "ACME-PTS",
    "tokenClassId": "<TOKEN_CLASS_ID>",
    "programId": "fungible",
    "preHooks": [
      {"hookId": "max-supply",  "priority": 5,  "enabled": true, "operations": ["mint"]},
      {"hookId": "min-balance", "priority": 5,  "enabled": true, "operations": ["transfer", "burn", "lock", "debit"]},
      {"hookId": "validation",  "priority": 10, "enabled": true},
      {"hookId": "logging",     "priority": 20, "enabled": true}
    ],
    "postHooks": [
      {"hookId": "logging", "priority": 1, "enabled": true}
    ],
    "operationOverrides": {},
    "config": {
      "stateCommitmentAlgorithm": "sha256"
    }
  }
}
```
Response `201` with `programId:"fungible"`, `status:"active"`.

Keep `lock` in the `min-balance` operations: a transfer's source step runs as `lock`, so without it transfers go unchecked. The consequence is that every `lock` you send must carry `value` (whole-token locks fail, see above). `operations` filters are honoured by the engine; a hook with no `operations` list applies to every operation it handles itself (min-balance: transfer, burn, lock, debit), so the explicit list here is equivalent and just clearer.

**Step 3: first mint (the treasury reserve)**

```json
POST /v1/token/mint
{
  "context": {"id":"api.token.mint","version":"1.0","ts":"2026-10-03T10:01:00Z","msgId":"9a7e3c10-5b6d-4e2f-a1c8-7d4e0f2b3a55",
              "developerToken":"<DEV_TOKEN>","authorization":"Bearer <OPERATOR_JWT>","valueFormat":"raw"},
  "payload": {
    "tokenClass": "ACME-PTS",
    "initialSupply": "500000000",
    "metadata": {"name": "ACME Points Treasury", "tags": {"desk": "loyalty"}},
    "data": {"programme": "ACME-REWARDS-2026"}
  }
}
```
- **Do not send `identities`.** The engine makes the caller issuer, creator and owner.
- `initialSupply` `"500000000"` raw = 5,000,000.00 points. With `valueFormat:"display"` you would send `"5000000.00"`.

Response `200`:
```json
{"context":{"id":"api.token.mint","…":"…","transactionId":"0199c0de-…","status":"successful"},
 "response":{"txId":"0199c0de-…","status":"submitted","message":"domain_lifecycle_workflow_submitted",
             "estimatedCompletionTime":"2026-10-03T10:01:30Z"}}
```
Then poll as in §6.1. What happens afterwards:
- A **second mint** by the same operator *adds supply to the same treasury token*, because fungible tokens are one per owner per class. You can't mint into a customer's account, and you can't hold several operator-owned tokens of one fungible class.
- Customers get their own token (balance only) when they first **receive a transfer**. Transfer was failing on sanctum in Aug 2026 (`recipient_address_not_found`), so until it works on your instance keep per-customer balances off-ledger (`worked-examples.md` D7).
- A mint that would push total supply past `maxSupply` fails at poll time with `MAX_SUPPLY_EXCEEDED`.

Resulting token state (`/v1/token/get`, `valueFormat:"raw"`):
```json
"state": {"status":"active",
          "supply":{"totalSupply":"500000000","circulatingSupply":"500000000","usedSupply":"0","availableSupply":"500000000"},
          "balance":"500000000","effectiveFrom":"2026-10-03T10:01:01Z"}
```
Next operations (burn, freeze, lock, transfer) are covered in `token-programs.md` §4.

---

### 6.3 (b) Soulbound KYC credential class `ACME-KYC`

**Step 1: class**

```json
POST /v1/tokenclass/register
{
  "context": {"id":"api.tokenclass.register","version":"1.0","ts":"…","msgId":"…","developerToken":"<DEV_TOKEN>","authorization":"Bearer <OPERATOR_JWT>"},
  "payload": {
    "tokenClass": "ACME-KYC",
    "tokenStandard": "UNITS-CREDENTIAL",
    "name": "ACME KYC Credential",
    "description": "Soulbound W3C VC attesting that ACME completed KYC (document + face match) for the holder.",
    "schema": {
      "type": "object",
      "required": ["@context", "type", "issuer", "credentialSubject"],
      "properties": {
        "@context": {"type": "array"}, "type": {"type": "array"},
        "issuer": {"type": ["string", "object"]},
        "validFrom": {"type": "string", "format": "date-time"},
        "validUntil": {"type": "string", "format": "date-time"},
        "credentialSubject": {"type": "object"},
        "evidence": {"type": "array"}
      }
    },
    "metadata": {
      "fungible": false, "symbol": "AKYC", "category": "credential",
      "transferable": false, "divisible": false, "burnable": false,
      "revocable": true, "soulbound": true
    }
  }
}
```
The `schema` describes the VC that ends up in `token.data`. The `credential` program stores the VC **at the top level of `data`**, not under `verifiableCredential` (the seeded CREDENTIAL schema is wrong about that).

**Step 2: config**

```json
POST /v1/tokenclassconfig/register
{
  "context": {"id":"api.tokenclassconfig.register","version":"1.0","ts":"…","msgId":"…","developerToken":"<DEV_TOKEN>","authorization":"Bearer <OPERATOR_JWT>"},
  "payload": {
    "tokenClass": "ACME-KYC",
    "tokenClassId": "<TOKEN_CLASS_ID>",
    "programId": "credential",
    "preHooks":  [{"hookId":"logging","priority":10,"enabled":true}],
    "postHooks": [{"hookId":"logging","priority":10,"enabled":true}],
    "operationOverrides": {
      "transfer": {"disabled": true, "reason": "Soulbound tokens cannot be transferred"},
      "burn":     {"disabled": true, "reason": "Credentials cannot be burned"}
    },
    "config": {"stateCommitmentAlgorithm": "sha256"}
  }
}
```
(The overrides are documentation only. The program itself has no transfer or burn.) `examples/token-classes/acme-kyc.credential.json` also lists a `validation` pre-hook. Both configs behave the same: the `validation` hook only checks transfer and burn, which a credential never runs, so it's optional here.

**Step 3: issue to a user with `/v1/token/add`** (developer token only, **no `authorization`**)

```json
POST /v1/token/add
{
  "context": {"id":"api.token.add","version":"1.0","ts":"2026-10-03T11:00:00Z","msgId":"…","developerToken":"<DEV_TOKEN>"},
  "payload": {
    "tokenClass": "ACME-KYC",
    "owner": "<sha256(lower(trim(user address)))>",
    "credential": {
      "@context": ["https://www.w3.org/ns/credentials/v2"],
      "type": ["VerifiableCredential", "KYCCredential"],
      "issuer": {"id": "did:web:acme.example", "name": "ACME Fintech"},
      "validFrom": "2026-10-03T11:00:00Z",
      "validUntil": "2027-10-03T11:00:00Z",
      "credentialSubject": {
        "id": "<same sha256 address hash>",
        "documentType": "aadhaar",
        "country": "IN",
        "faceMatchVerified": true,
        "faceMatchPercentage": "97.4",
        "givenName": "Asha",
        "familyName": "Rao",
        "documentNumber": "XXXX-XXXX-1234"
      },
      "evidence": [{
        "type": ["KYCEvidence"],
        "rawPayload": {"provider": "acme-kyc-v2", "checkId": "KYC-88213", "livenessScore": 0.98}
      }]
    },
    "metadata": {"name": "ACME KYC — Asha Rao", "tokenStandard": "UNITS-CREDENTIAL"}
  }
}
```
Rules:
- `owner` must be the **address hash** of an existing account, else `404 "Owner address not found"`.
- `credentialSubject` is **closed** (`additionalProperties:false`). Required: `id`, `documentType`, `country`, `faceMatchVerified` (bool) and `faceMatchPercentage` (string). Optional: `givenName`, `familyName`, `documentNumber`, `documentExpired`, `dateOfBirth`, `address` and `gender`. Put any other domain data in `evidence[].rawPayload`, which is unconstrained. Image URLs found there are downloaded to blob storage.
- `metadata` is **required** for credentials: `{name, tokenStandard}`.

Response `200`: `{"txId":"…","status":"submitted","message":"credential_add_transaction_submitted","estimatedCompletionTime":"…"}`.
**Poll with the holder's session (`<USER_JWT>`).** The operator gets `403 FORBIDDEN "not authorized to access this transaction"`.

> **Ownership caveat (code-verified):** the credential's identities are set to the holder as **both `owner` and `issuer`**, and your operator gets **no identity on the token**. So `revoke`, `suspend` and `resume` must be done by the holder, or by you under a `transact` delegation the holder grants (`tokens:id:<uuid>` or `tokens:tokenclass:ACME-KYC`). Design revocation around this, or ask Finternet about issuer-side revocation on your instance.

---

### 6.4 (c) Lender's loan class `ACME-LOAN` on `loan-nft-program`

Why your own class: the seeded `LOAN-NFT` can be minted only by the account `realassets-admin`.

**Step 1: class**

```json
POST /v1/tokenclass/register
{
  "context": {"id":"api.tokenclass.register","version":"1.0","ts":"…","msgId":"…","developerToken":"<DEV_TOKEN>","authorization":"Bearer <OPERATOR_JWT>"},
  "payload": {
    "tokenClass": "ACME-LOAN",
    "tokenStandard": "UNITS-Loan",
    "name": "ACME Finance Loan",
    "description": "One token per loan account originated by ACME Finance (NBFC). Carries the full lifecycle state.",
    "schema": {
      "type": "object",
      "description": "LoanData (camelCase). u128 amounts are integer strings; tenure/emiDay/dpd are integers. Validation is done by loan-nft-program.",
      "properties": {
        "loanRefId": {"type": "string"},
        "loanAmount": {"type": "string", "pattern": "^[0-9]+$"},
        "currency": {"type": "string"},
        "loanEntityStatus": {"type": "string", "enum": ["Active","Delinquent","NPA","WrittenOff","Closed"]},
        "principalOutstanding": {"type": "string", "pattern": "^[0-9]+$"},
        "tenure": {"type": "integer"},
        "dpd": {"type": "integer"}
      }
    },
    "metadata": {
      "fungible": false, "symbol": "ALOAN", "category": "loan",
      "transferable": false, "divisible": false, "burnable": false, "revocable": false, "soulbound": false,
      "valueCurrency": "INR",
      "valuation": {"parValue": null, "currency": "INR", "region": "IN", "compliance": "RBI"}
    }
  }
}
```
Use `"fungible": false`. Otherwise the engine looks up an existing "per-owner" token on mint.

**Step 2: config**

```json
POST /v1/tokenclassconfig/register
{
  "context": {"id":"api.tokenclassconfig.register","version":"1.0","ts":"…","msgId":"…","developerToken":"<DEV_TOKEN>","authorization":"Bearer <OPERATOR_JWT>"},
  "payload": {
    "tokenClass": "ACME-LOAN",
    "tokenClassId": "<TOKEN_CLASS_ID>",
    "programId": "loan-nft-program",
    "preHooks":  [{"hookId":"logging","priority":20,"enabled":true}],
    "postHooks": [{"hookId":"logging","priority":1,"enabled":true}],
    "operationOverrides": {},
    "config": {"stateCommitmentAlgorithm": "sha256"}
  }
}
```

**Step 3: originate a loan (`mint`, which is the same as `loan_originated`)**

```json
POST /v1/token/mint
{
  "context": {"id":"api.token.mint","version":"1.0","ts":"2026-10-03T12:00:00Z","msgId":"…","developerToken":"<DEV_TOKEN>","authorization":"Bearer <OPERATOR_JWT>","valueFormat":"raw"},
  "payload": {
    "tokenClass": "ACME-LOAN",
    "initialSupply": "1",
    "metadata": {"name": "ACME-LN-2026-000123"},
    "data": {
      "loanRefId": "ACME-LN-2026-000123",
      "loanAmount": "500000",
      "currency": "INR",
      "loanType": "TwoWheelerLoan",
      "program": "ACME-2W",
      "sourcingState": "KA",
      "originationDate": "2026-10-03",
      "sanctionDate": "2026-10-01",
      "firstEmiDate": "2026-11-05",
      "interestRateType": "Fixed",
      "collateralType": "Vehicle",
      "borrowerId": "<borrower ref: address hash or your CIF id>",
      "coBorrowerIds": [],
      "guarantorIds": [],
      "productCode": "2W-STD",
      "disbursementSchedule": [{"tranche": 1, "plannedDate": "2026-10-04", "plannedAmount": "500000"}],
      "prepaymentLockInMonths": 6,
      "lockInRestriction": "NoForeclosure",
      "cersaiApplicable": true,
      "interestRate": "1450",
      "tenure": 36,
      "emiDay": 5,
      "emiPerMonth": "17208",
      "maturityDate": "2029-10-05",
      "foir": "1",
      "penalRate": "200"
    }
  }
}
```
Rules (full field reference in `token-programs.md` §9):
- `u128` fields are **integer strings** with no decimal point (`"12.5"` fails with "invalid digit found in string"). `u32` fields (`tenure`, `emiDay`, `prepaymentLockInMonths`, `tranche`) are **JSON numbers**. Enums are PascalCase.
- `foir` must be an integer string in **1..10000** in current code (the bound suggests basis points); the error text says "(0, 1]", which is misleading. `"0"` fails. **Send `"1"`** (live-verified).
- Rates are uninterpreted integers. Choose a convention (e.g. bps, `"1450"` = 14.50%) and keep to it.
- Don't send `identities`. **Dedupe on `loanRefId` yourself**, because a retried mint creates a second loan.
- Keys outside `LoanOriginatedPayload` are accepted but **not stored**. For collateral details (gold weight, purity, packet id), bullet or interest-only repayment and `cersaiApplicable`, see `token-programs.md` §9.4.1.

The response is `{txId, status:"submitted"}`. Poll, then resolve the tokenId (§6.1). The loan starts with `loanEntityStatus:"Active"`, `disbursementStatus:"NotStarted"`, `principalOutstanding:"0"`.

First domain operation (record the lien):
```json
POST /v1/token/transact
{"context":{"id":"api.token.transact","version":"1.0","ts":"…","msgId":"…","developerToken":"<DEV_TOKEN>","authorization":"Bearer <OPERATOR_JWT>","valueFormat":"raw"},
 "payload":{"operation":"cersai_registered","tokenId":"<loan tokenId>",
            "data":{"regNumber":"CERSAI-2026-KA-000123","cersaiDate":"2026-10-04"}},
 "signature":{"keyId":"<operator key id>","jws":"<base64 Ed25519 over JCS(payload)>"}}
```
→ `202 {"txId":"…","status":"submitted","message":"Domain lifecycle workflow submitted for primitive orchestration","workflowInstanceId":"…"}`.

---

### 6.5 (d) Unique asset class `ACME-DEED` on `non-fungible`

> Status: in code, **not exercised live**. Run a test mint and transfer on sanctum before you build on it.

```json
POST /v1/tokenclass/register
{
  "context": {"id":"api.tokenclass.register","version":"1.0","ts":"…","msgId":"…","developerToken":"<DEV_TOKEN>","authorization":"Bearer <OPERATOR_JWT>"},
  "payload": {
    "tokenClass": "ACME-DEED",
    "tokenStandard": "UNITS-NFT",
    "name": "ACME Property Deed",
    "description": "One token per registered property title held in ACME custody.",
    "schema": {
      "type": "object",
      "required": ["assetId", "assetType", "legalDocHash"],
      "properties": {
        "assetId": {"type": "string"},
        "assetType": {"type": "string", "enum": ["property", "vehicle", "certificate", "document"]},
        "legalDocHash": {"type": "string", "pattern": "^[a-f0-9]{64}$"},
        "jurisdiction": {"type": "string"},
        "valuation": {"type": "string", "pattern": "^[0-9]+$"}
      }
    },
    "metadata": {"fungible": false, "decimals": 0, "symbol": "DEED", "category": "real_world_asset",
                 "transferable": true, "divisible": false, "burnable": true, "revocable": false, "soulbound": false}
  }
}
```

```json
POST /v1/tokenclassconfig/register
{
  "context": {"id":"api.tokenclassconfig.register","version":"1.0","ts":"…","msgId":"…","developerToken":"<DEV_TOKEN>","authorization":"Bearer <OPERATOR_JWT>"},
  "payload": {
    "tokenClass": "ACME-DEED", "tokenClassId": "<TOKEN_CLASS_ID>", "programId": "non-fungible",
    "preHooks": [{"hookId":"validation","priority":10,"enabled":true},{"hookId":"logging","priority":20,"enabled":true}],
    "postHooks": [{"hookId":"logging","priority":1,"enabled":true}],
    "config": {"stateCommitmentAlgorithm": "sha256"}
  }
}
```
The `validation` pre-hook is what enforces "only the owner (or an operator/admin/access identity) may burn or transfer". The NFT program itself has no owner check. **Always include it for NFTs.**

```json
POST /v1/token/mint
{
  "context": {"id":"api.token.mint","version":"1.0","ts":"…","msgId":"…","developerToken":"<DEV_TOKEN>","authorization":"Bearer <OPERATOR_JWT>","valueFormat":"raw"},
  "payload": {
    "tokenClass": "ACME-DEED",
    "initialSupply": "1",
    "metadata": {"name": "Plot 42, Whitefield", "description": "Freehold residential plot"},
    "data": {"assetId": "PROP-BLR-000042", "assetType": "property",
             "legalDocHash": "3f2a…(64 hex)…9c", "jurisdiction": "IN-KA", "valuation": "8500000"}
  }
}
```
Each mint creates a **new** token. An empty `metadata.name` becomes `"ACME-DEED #<first 8 chars of id>"`. You can't mint additional supply into an NFT.

---

### 6.6 (e) Proxy stablecoin class `ACME-USD` (PROXY-FT) on `stables`

First check whether a seeded class already covers your asset and chain. `USDC`, for example, covers Ethereum, Base, Sepolia, Base Sepolia and Solana. Seeded proxies have `identities:[]`, so anyone can import into them. Register your own only for an unlisted token or chain. In this example the asset is a hypothetical ACME-issued USD stablecoin on Base Sepolia.

```json
POST /v1/tokenclass/register
{
  "context": {"id":"api.tokenclass.register","version":"1.0","ts":"…","msgId":"…","developerToken":"<DEV_TOKEN>","authorization":"Bearer <OPERATOR_JWT>"},
  "payload": {
    "tokenClass": "ACME-USD",
    "tokenStandard": "PROXY-FT",
    "name": "ACME USD (proxy)",
    "description": "UNITS shadow balance of the ACME USD ERC-20 on Base Sepolia.",
    "schema": {
      "type": "object",
      "properties": {"balance": {"type": "string", "pattern": "^[0-9]+$"}, "chainId": {"type": "string"}},
      "required": ["balance", "chainId"]
    },
    "metadata": {
      "decimals": 6, "symbol": "AUSD", "fungible": true, "category": "stablecoin",
      "transferable": true, "divisible": true, "burnable": false, "revocable": false, "soulbound": false,
      "proxyFor": "native",
      "contractIds": {
        "eip155:84532": "0x1111111111111111111111111111111111111111"
      },
      "valuation": {"parValue": "1", "currency": "USD", "region": "global", "compliance": "regulated"}
    }
  }
}
```
`contractIds` keys are **CAIP-2** chain ids (`eip155:<chainId>` or `solana:<genesis hash>`). Values are the token contract or mint address.

```json
POST /v1/tokenclassconfig/register
{
  "context": {"id":"api.tokenclassconfig.register","version":"1.0","ts":"…","msgId":"…","developerToken":"<DEV_TOKEN>","authorization":"Bearer <OPERATOR_JWT>"},
  "payload": {
    "tokenClass": "ACME-USD", "tokenClassId": "<TOKEN_CLASS_ID>", "programId": "stables",
    "preHooks":  [{"hookId":"validation","priority":1,"enabled":true},{"hookId":"logging","priority":10,"enabled":true}],
    "postHooks": [{"hookId":"logging","priority":1,"enabled":true}],
    "operationOverrides": {},
    "config": {"stateCommitmentAlgorithm": "sha256"}
  }
}
```

First import (the user's own on-chain balance). Prerequisite: the wallet address must be an **active registered key** of the owner, registered with `/v1/account/keys/register`.

```json
POST /v1/token/add
{
  "context": {"id":"api.token.add","version":"1.0","ts":"…","msgId":"…","developerToken":"<DEV_TOKEN>","authorization":"Bearer <USER_JWT>"},
  "payload": {
    "tokenClass": "ACME-USD",
    "chainId": "eip155:84532",
    "contractAddress": "0x1111111111111111111111111111111111111111",
    "walletAddress": "0xAbC0000000000000000000000000000000000001",
    "value": "25000000"
  }
}
```
- `value` is in **base units** (`^[0-9]+$`): `25000000` with 6 decimals = 25.00. The `stables` program reads the on-chain balance through the chain adapter and fails with `INSUFFICIENT_BALANCE` if the chain holds less than `value`.
- With a user session, the owner is the session account. Sessionless B2B calls send `"owner":"<address hash>"` instead.
- Importing the same (owner, chain, contract, wallet) again **with a session** becomes `reconcile` (refresh from chain). Sessionless, it gives `409 CONFLICT`.

Response `200`: `{"txId":"…","status":"submitted","message":"proxy_token_import_submitted"}`. Poll as usual. Environment-dependent: it needs the instance's chain adapter to be reachable for that chain.

---

### 6.7 (f) Purpose-bound voucher class `ACME-MEAL` (**blocked today**)

> **Honest status:** on current builds the `purpose-bound-voucher` program's capabilities don't include `DomainLifecycle` or `Mint`. Every `mint`, `issue`, `redeem` and `revoke` submitted through the API is accepted (`txId`) and then **fails at poll time**:
> `CAPABILITY_DENIED: program 'purpose-bound-voucher' does not support federation primitive 'domain_lifecycle' (supported: ["Lock","CommitDebit","Unlock","CreateIncoming","CommitCredit","RejectIncoming","Credit"])`.
> The class and config register fine, so you can prepare them now. Re-test after Finternet ships the fix.

```json
POST /v1/tokenclass/register
{
  "context": {"id":"api.tokenclass.register","version":"1.0","ts":"…","msgId":"…","developerToken":"<DEV_TOKEN>","authorization":"Bearer <OPERATOR_JWT>"},
  "payload": {
    "tokenClass": "ACME-MEAL",
    "tokenStandard": "UNITS-SFT",
    "name": "ACME Meal Voucher",
    "description": "Purpose-bound employee meal voucher with per-category caps.",
    "schema": {
      "type": "object",
      "required": ["value", "status", "expiryDate"],
      "properties": {
        "value": {"type": "string", "pattern": "^[0-9]+$"},
        "categoryLimits": {"type": "object", "additionalProperties": {"type": "string", "pattern": "^[0-9]+$"}},
        "status": {"type": "string", "enum": ["Created", "Active", "Redeemed", "Revoked", "TransferredOut"]},
        "expiryDate": {"type": "string", "format": "date"}
      }
    },
    "metadata": {
      "decimals": 2, "symbol": "AMEAL", "fungible": false, "category": "voucher",
      "transferable": false, "divisible": false, "burnable": false, "revocable": true, "soulbound": false,
      "redeemableCategories": ["meals", "groceries", "beverages"],
      "escrowCurrency": "USDC",
      "valuation": {"parValue": "1", "currency": "INR", "region": "IN", "compliance": "RBI"}
    }
  }
}
```

```json
POST /v1/tokenclassconfig/register
{
  "context": {"id":"api.tokenclassconfig.register","version":"1.0","ts":"…","msgId":"…","developerToken":"<DEV_TOKEN>","authorization":"Bearer <OPERATOR_JWT>"},
  "payload": {
    "tokenClass": "ACME-MEAL", "tokenClassId": "<TOKEN_CLASS_ID>", "programId": "purpose-bound-voucher",
    "preHooks": [
      {"hookId":"validation","priority":1,"enabled":true},
      {"hookId":"credential-verification","priority":10,"enabled":true,"operations":["issue"]},
      {"hookId":"logging","priority":20,"enabled":true}
    ],
    "postHooks": [{"hookId":"logging","priority":1,"enabled":true}],
    "config": {
      "stateCommitmentAlgorithm": "sha256",
      "voucherTransfer": {"enabled": false},
      "credentialVerification": {"requiredCredentials": ["KYC-BASIC"], "additionalStatesKey": "beneficiary_credentials"},
      "additionalStateRequirements": [
        {"key":"beneficiary_credentials","tokenClass":"ACME-KYC","ownerFrom":"payload.to","operations":["issue"],"multiple":true}
      ]
    }
  }
}
```
`requiredCredentials` matches the **string** `data.type` of the beneficiary's Active credential tokens (see the §3.2 caveat). A W3C VC with an array `type` won't match. Leave `requiredCredentials` empty (`[]`) if your credentials are standard VCs.

The mint payload you would send (it fails today with `CAPABILITY_DENIED`):
```json
POST /v1/token/mint
{"context":{"id":"api.token.mint","version":"1.0","ts":"…","msgId":"…","developerToken":"<DEV_TOKEN>","authorization":"Bearer <OPERATOR_JWT>","valueFormat":"raw"},
 "payload":{"tokenClass":"ACME-MEAL","initialSupply":"300000",
   "metadata":{"name":"ACME Meal Voucher Oct-2026","tokenStandard":"UNITS-SFT"},
   "data":{"value":"300000","categoryLimits":{"meals":"200000","groceries":"100000"},
           "status":"Created","expiryDate":"2027-03-31"}}}
```

**Workaround (live-verified):** register a `UNITS-FT` class on `fungible` (e.g. `ACME-MEAL-FT`, `decimals:2`), mint the voucher value to the operator, and enforce categories, caps and expiry **in your application**. You lose on-ledger category enforcement, but you keep an auditable, hash-chained balance.

---

### 6.8 (g) Loan pool class `ACME-POOL` on `loan-pool-nft-program`

> Status: in code, not exercised live.

```json
POST /v1/tokenclass/register
{
  "context": {"id":"api.tokenclass.register","version":"1.0","ts":"…","msgId":"…","developerToken":"<DEV_TOKEN>","authorization":"Bearer <OPERATOR_JWT>"},
  "payload": {
    "tokenClass": "ACME-POOL",
    "tokenStandard": "UNITS-LoanPool",
    "name": "ACME Securitisation Pool",
    "description": "One token per PTC/DA pool of ACME-LOAN tokens.",
    "schema": {
      "type": "object",
      "description": "LoanPoolData — snake_case keys, money as integer strings, FLDG upper-case key.",
      "required": ["pool_ref_id", "pool_type", "loan_token_ids", "loan_count", "originator_id", "cutoff_date", "total_pool_amount"],
      "properties": {
        "pool_ref_id": {"type": "string"},
        "pool_type": {"type": "string", "enum": ["PassThroughCertificate", "DirectAssignment"]},
        "loan_token_ids": {"type": "array", "items": {"type": "string"}},
        "loan_count": {"type": "integer", "minimum": 1},
        "total_pool_amount": {"type": "string", "pattern": "^[0-9]+$"},
        "FLDG": {"type": "string"},
        "pool_status": {"type": "string", "enum": ["Active", "Closed"]}
      }
    },
    "metadata": {
      "fungible": false, "symbol": "APOOL", "category": "loan-pool",
      "transferable": false, "divisible": false, "burnable": false, "revocable": false, "soulbound": true,
      "valueCurrency": "INR",
      "valuation": {"parValue": null, "currency": "INR", "region": "IN", "compliance": "RBI-SEBI"}
    }
  }
}
```

```json
POST /v1/tokenclassconfig/register
{
  "context": {"id":"api.tokenclassconfig.register","version":"1.0","ts":"…","msgId":"…","developerToken":"<DEV_TOKEN>","authorization":"Bearer <OPERATOR_JWT>"},
  "payload": {
    "tokenClass": "ACME-POOL", "tokenClassId": "<TOKEN_CLASS_ID>", "programId": "loan-pool-nft-program",
    "preHooks":  [{"hookId":"logging","priority":20,"enabled":true}],
    "postHooks": [{"hookId":"logging","priority":20,"enabled":true}],
    "config": {
      "stateCommitmentAlgorithm": "sha256",
      "additionalStateRequirements": [
        {"key":"loan_tokens","tokenClass":"ACME-LOAN","tokenIdsFrom":"payload.data.loan_token_ids","operations":["mint"],"multiple":true}
      ]
    }
  }
}
```
(This uses `payload.data.loan_token_ids` rather than the seed's `payload.loan_token_ids`; see the §3.4 path caveat.)

```json
POST /v1/token/mint
{
  "context": {"id":"api.token.mint","version":"1.0","ts":"…","msgId":"…","developerToken":"<DEV_TOKEN>","authorization":"Bearer <OPERATOR_JWT>","valueFormat":"raw"},
  "payload": {
    "tokenClass": "ACME-POOL",
    "initialSupply": "1",
    "data": {
      "pool_ref_id": "ACME-PTC-2026-01",
      "pool_type": "PassThroughCertificate",
      "loan_token_ids": ["<loan tokenId 1>", "<loan tokenId 2>"],
      "loan_count": 2,
      "originator_id": "acme-finance",
      "trustee_id": "axis-trustee",
      "investor_id": "mf-alpha",
      "cutoff_date": "2026-09-30",
      "total_pool_amount": "1000000",
      "min_seasoning_months": 6,
      "expected_maturity_date": "2029-10-05",
      "payout_day": "2026-11-15",
      "investor_share": "0.90",
      "active_loan_count": 2, "delinquent_loan_count": 0, "npa_loan_count": 0,
      "closed_loan_count": 0, "written_off_loan_count": 0,
      "pool_outstanding": "950000",
      "investor_os": "855000",
      "FLDG": "50000",
      "dpd_bucket_distribution": {
        "current_count": 2, "dpd_1_30_count": 0, "dpd_31_60_count": 0, "dpd_61_90_count": 0, "dpd_90_plus_count": 0,
        "dpd_1_30_amount": "0", "dpd_31_60_amount": "0", "dpd_61_90_amount": "0", "dpd_90_plus_amount": "0"
      },
      "current_rating": "AAA"
    }
  }
}
```
Rules:
- Keys are **snake_case**, except `FLDG`. Money values are **strings**: integers for `total_pool_amount`, `investor_os` and `pool_outstanding`. `investor_share` is a decimal string.
- Counts are numbers. `loan_count` must equal `len(loan_token_ids)` and the five status counts.
- A `PassThroughCertificate` pool requires `trustee_id`.
- Loan composition is **immutable** after mint.

---

## 7. Seeded token classes (27)

Seeded by `units-api/scripts/seed/02-token-classes.sql` on every instance built from the repo. **Only the class issuer can mint into owned classes.** Open classes (`identities:[]`) can be used by anyone, but you don't control their config. So integrators normally **register their own classes** and use seeded ones only for proxy stablecoins (and NFH-T for experiments).

| tokenClass | Standard | Program | Decimals | Symbol / category | Identities | Notable metadata |
|---|---|---|---|---|---|---|
| USDC | PROXY-FT | stables | 6 | USDC / stablecoin | `[]` (open) | contractIds: eip155:1, 8453, 11155111, 84532, solana main, solana devnet |
| USDT | PROXY-FT | stables | 6 | USDT / stablecoin | `[]` | eip155:1, 8453, 11155111, solana main & devnet |
| EURC | PROXY-FT | stables | 6 | EURC / stablecoin | `[]` | eip155:1, 8453, solana main; MiCA |
| ETH | PROXY-FT | stables (**blake3**) | 18 | ETH / native_asset | `[]` | WETH on eip155:1, 8453, 11155111, 84532; solana main |
| SOL | PROXY-FT | stables (**blake3**) | 9 | SOL / native_asset | `[]` | wSOL solana main & devnet; eip155:1 |
| BTC | PROXY-FT | stables | 8 | BTC / native_asset | `[]` | WBTC/cbBTC eip155:1, 8453; solana main |
| DAI | PROXY-FT | stables | 18 | DAI / stablecoin | `[]` | eip155:1, 8453, 11155111 |
| PYUSD | PROXY-FT | stables | 6 | PYUSD / stablecoin | `[]` | eip155:1, solana main |
| FDUSD | PROXY-FT | stables | 18 | FDUSD / stablecoin | `[]` | eip155:1, solana main |
| USDe | PROXY-FT | stables | 18 | USDe / stablecoin | `[]` | **unreachable**: stored mixed-case, API looks up `USDE` |
| USDS | PROXY-FT | stables | 18 | USDS / stablecoin | `[]` | eip155:1, 8453, solana main |
| GHO | PROXY-FT | stables | 18 | GHO / stablecoin | `[]` | eip155:1 |
| RLUSD | PROXY-FT | stables | 18 | RLUSD / stablecoin | `[]` | eip155:1 |
| FRAX | PROXY-FT | stables | 18 | FRAX / stablecoin | `[]` | eip155:1 |
| USDP | PROXY-FT | stables | 18 | USDP / stablecoin | `[]` | eip155:1 |
| GUSD | PROXY-FT | stables | 2 | GUSD / stablecoin | `[]` | eip155:1 |
| crvUSD | PROXY-FT | stables | 18 | crvUSD / stablecoin | `[]` | **unreachable** (case bug: `CRVUSD`) |
| LUSD | PROXY-FT | stables | 18 | LUSD / stablecoin | `[]` | eip155:1 |
| TUSD | PROXY-FT | stables | 18 | TUSD / stablecoin | `[]` | eip155:1 |
| XSGD | PROXY-FT | stables | 6 | XSGD / stablecoin (SGD) | `[]` | eip155:1 |
| EURS | PROXY-FT | stables | 2 | EURS / stablecoin (EUR) | `[]` | eip155:1 |
| GYEN | PROXY-FT | stables | 6 | GYEN / stablecoin (JPY) | `[]` | eip155:1 |
| NFH-T | UNITS-FT | fungible | 2 | NFH / utility | `[]` (anyone may mint) | `maxSupply:"100000000000"`, `minBalance:"10000"`, burnable |
| CREDENTIAL | UNITS-CREDENTIAL | credential | — | CRED / credential | `[]` | soulbound, revocable, `defaultValidityDays:365` (unused) |
| SODEXO-MV | UNITS-SFT | purpose-bound-voucher | 2 | SODEXO-MV / voucher | `[]` | `redeemableCategories:[groceries,beverages,meals,snacks,dairy,bakery]`, `escrowCurrency:"USDC"`, transferable false. **Mint blocked** |
| LOAN-NFT | UNITS-Loan | loan-nft-program | — | LOAN / loan | `[{"id":"realassets-admin","type":"Issuer"}]` | `allowedMinters:["realassets-admin"]` (informational), `valueCurrency:"INR"` |
| LOAN-POOL | UNITS-LoanPool | loan-pool-nft-program | — | LOAN-POOL / loan-pool | `[{"id":"realassets-admin","type":"Issuer"}]` | soulbound, compliance RBI-SEBI |

Fixed class ids use the prefix `01938000-0000-7000-8000-0000000000xx`: USDC `…10`, USDT `…11`, EURC `…12`, ETH `…13`, SOL `…14`, BTC `…15`, DAI `…16`, NFH-T `…17`, CREDENTIAL `…18`, PYUSD `…19`, SODEXO-MV `…1a`, FDUSD `…1b`, USDe `…1c`, USDS `…1d`, GHO `…1e`, RLUSD `…1f`, FRAX `…30`, USDP `…31`, GUSD `…32`, crvUSD `…33`, LUSD `…34`, TUSD `…35`, XSGD `…36`, EURS `…37`, GYEN `…38`, LOAN-POOL `…39`. LOAN-NFT is `019d0a5d-2671-76a3-9856-28755c8a2992`. Config ids are the class ids + 0x10 (USDC config `…20`, NFH-T `…27`, CREDENTIAL `…28`, SODEXO-MV `…2a`, LOAN-POOL `…49`, …). LOAN-NFT config is `019d0a5e-3d19-749f-8536-adafbbdd588c`. On a long-lived instance, ids may differ. **Read them with `tokenclass/get`.**

USDC contract addresses (for `/token/add`):

| chainId (CAIP-2) | Network | USDC contract / mint |
|---|---|---|
| `eip155:1` | Ethereum | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| `eip155:8453` | Base | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| `eip155:11155111` | Sepolia | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |
| `eip155:84532` | Base Sepolia | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | Solana mainnet | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` | Solana devnet | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |

For the other proxies, read `metadata.contractIds` with `POST /v1/tokenclass/get {"tokenClass":"USDT"}`.

### 7.1 Verbatim seed rows (representative)

**USDC** (the template for all PROXY-FT classes):
```sql
INSERT INTO token_classes (id, token_class, token_standard, name, description, schema, identities, metadata, status) VALUES (
  '01938000-0000-7000-8000-000000000010'::UUID, 'USDC', 'PROXY-FT', 'USD Coin',
  'Circle USD stablecoin backed 1:1 by USD reserves. Regulated and audited.',
  '{"type":"object","properties":{
      "balance":{"type":"string","pattern":"^[0-9]+$","description":"On-chain balance in smallest unit (6 decimals)"},
      "chainId":{"type":"string","description":"CAIP-2 chain ID where this balance is held"}},
    "required":["balance","chainId"]}'::JSONB,
  '[]'::JSONB,
  '{"decimals":6,"symbol":"USDC","fungible":true,"category":"stablecoin",
    "transferable":true,"divisible":true,"burnable":false,"revocable":false,"soulbound":false,
    "proxyFor":"native",
    "contractIds":{
      "eip155:1":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      "eip155:8453":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "eip155:11155111":"0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      "eip155:84532":"0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG":"4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"},
    "valuation":{"parValue":"1","currency":"USD","region":"global","compliance":"regulated"}}'::JSONB,
  'active');
-- config (ETH/SOL identical but "blake3"):
('01938000-0000-7000-8000-000000000020'::UUID, 'USDC', '01938000-0000-7000-8000-000000000010'::UUID, 'stables',
 '[{"hookId":"validation","priority":1,"enabled":true},{"hookId":"logging","priority":10,"enabled":true}]'::JSONB,
 '[{"hookId":"logging","priority":1,"enabled":true}]'::JSONB, '{}'::JSONB,
 '{"stateCommitmentAlgorithm":"sha256"}'::JSONB, 'active')
```

**NFH-T** (native fungible with constraints):
```sql
('01938000-0000-7000-8000-000000000017'::UUID, 'NFH-T', 'UNITS-FT', 'Network for Humanities Token',
 'Token for the Network for Humanities project with supply and balance constraints',
 '{"type":"object","properties":{"supply":{"type":"object","properties":{
     "total":{"type":"string","pattern":"^[0-9]+$"},"circulating":{"type":"string","pattern":"^[0-9]+$"}}}},
   "required":["supply"]}'::JSONB,
 '[]'::JSONB,
 '{"decimals":2,"symbol":"NFH","fungible":true,"category":"utility","transferable":true,"divisible":true,
   "burnable":true,"revocable":false,"soulbound":false,"maxSupply":"100000000000","minBalance":"10000",
   "valuation":{"parValue":"0","currency":null,"region":"global","compliance":null}}'::JSONB, 'active')
-- config:
('01938000-0000-7000-8000-000000000027'::UUID, 'NFH-T', '01938000-0000-7000-8000-000000000017'::UUID, 'fungible',
 '[{"hookId":"max-supply","priority":5,"enabled":true,"operations":["mint"]},
   {"hookId":"min-balance","priority":5,"enabled":true,"operations":["transfer","burn","lock","debit"]},
   {"hookId":"validation","priority":10,"enabled":true},{"hookId":"logging","priority":20,"enabled":true}]'::JSONB,
 '[{"hookId":"logging","priority":1,"enabled":true}]'::JSONB, '{}'::JSONB,
 '{"stateCommitmentAlgorithm":"sha256",
   "stateCommitmentFields":["previous_commitment","last_tx_id","timestamp","token_id","owner","state","state_version"],
   "additionalStateRequirements":[{"key":"recipient","tokenClass":"SELF","ownerFrom":"payload.to",
                                   "operations":["transfer"],"multiple":false,"filters":null}]}'::JSONB, 'active')
```
(The `recipient` requirement is dead: no code consumes it, and transfers run as `lock` anyway.)

**CREDENTIAL**:
```sql
('01938000-0000-7000-8000-000000000018'::UUID, 'CREDENTIAL', 'UNITS-CREDENTIAL', 'Verifiable Credential',
 'W3C Verifiable Credential - Soulbound Token for identity documents and verifiable claims',
 '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","required":["verifiableCredential"],
   "properties":{"verifiableCredential":{"type":"object","required":["@context","type","issuer","credentialSubject"],
     "properties":{"@context":{"type":"array"},"id":{"type":"string"},"type":{"type":"array"},
       "issuer":{"type":["string","object"]},"validFrom":{"type":"string","format":"date-time"},
       "validUntil":{"type":"string","format":"date-time"},"credentialSubject":{"type":"object"},
       "credentialStatus":{"type":"object"},"evidence":{"type":"array"}}}}}'::JSONB,
 '[]'::JSONB,
 '{"fungible":false,"symbol":"CRED","category":"credential","transferable":false,"divisible":false,
   "burnable":false,"revocable":true,"soulbound":true,"defaultValidityDays":365}'::JSONB, 'active')
-- config:
('01938000-0000-7000-8000-000000000028'::UUID, 'CREDENTIAL', '01938000-0000-7000-8000-000000000018'::UUID, 'credential',
 '[{"hookId":"validation","priority":1,"enabled":true},{"hookId":"logging","priority":10,"enabled":true}]'::JSONB,
 '[{"hookId":"audit","priority":1,"enabled":true},{"hookId":"logging","priority":10,"enabled":true}]'::JSONB,
 '{"transfer":{"disabled":true,"reason":"Soulbound tokens cannot be transferred"},
   "burn":{"disabled":true,"reason":"Credentials cannot be burned"}}'::JSONB,
 '{"stateCommitmentAlgorithm":"sha256","defaultValidityDays":365}'::JSONB, 'active')
```
(The schema nests the VC under `verifiableCredential`, but the program stores it at the top of `data`. The `audit` hook id doesn't exist.)

**LOAN-NFT** (one shared class; the issuer is `realassets-admin`):
```sql
('019d0a5d-2671-76a3-9856-28755c8a2992'::UUID, 'LOAN-NFT', 'UNITS-Loan', 'Loan NFT',
 'Non-fungible token representing a single loan account. Carries the full lifecycle state of a loan from origination through closure. One shared class; all originators mint against it.',
 '{ … JSON Schema over ~50 camelCase LoanData keys, "additionalProperties": false … }'::JSONB,
 '[{"id":"realassets-admin","type":"Issuer"}]'::JSONB,
 '{"fungible":false,"symbol":"LOAN","category":"loan","transferable":true,"divisible":false,
   "burnable":false,"revocable":false,"soulbound":false,"valueCurrency":"INR",
   "allowedMinters":["realassets-admin"],
   "valuation":{"parValue":null,"currency":null,"region":"IN","compliance":"RBI"}}'::JSONB, 'active')
-- config:
('019d0a5e-3d19-749f-8536-adafbbdd588c'::UUID, 'LOAN-NFT', '019d0a5d-2671-76a3-9856-28755c8a2992'::UUID, 'loan-nft-program',
 '[{"hookId":"logging","priority":20,"enabled":true}]'::JSONB,
 '[{"hookId":"logging","priority":1,"enabled":true}]'::JSONB, '{}'::JSONB,
 '{"stateCommitmentAlgorithm":"sha256","includeDataInCommitment":true}'::JSONB, 'active')
```
(The identity id is the plaintext address `realassets-admin`. Both sides are hashed when compared, so the account with address `realassets-admin` is the issuer. `metadata.transferable:true` notwithstanding, `UNITS-Loan` tokens **cannot be transferred**: the API gate refuses them.)

**SODEXO-MV** (voucher; mint blocked):
```sql
('01938000-0000-7000-8000-00000000001a'::UUID, 'SODEXO-MV', 'UNITS-SFT', 'Sodexo Meal Voucher',
 'Purpose-bound meal voucher backed by stablecoin escrow. Redeemable at authorized merchants for groceries, beverages, and meals.',
 '{"type":"object","properties":{
     "value":{"type":"string","pattern":"^[0-9]+$","description":"Face value in smallest unit (2 decimals)"},
     "categoryLimits":{"type":"object","additionalProperties":{"type":"string","pattern":"^[0-9]+$"}},
     "status":{"type":"string","enum":["Created","Active","Redeemed","Revoked","TransferredOut"]},
     "expiryDate":{"type":"string","format":"date","description":"ISO 8601 date"}},
   "required":["value","status","expiryDate"]}'::JSONB,
 '[]'::JSONB,
 '{"decimals":2,"symbol":"SODEXO-MV","fungible":false,"category":"voucher","transferable":false,
   "divisible":false,"burnable":false,"revocable":true,"soulbound":false,
   "redeemableCategories":["groceries","beverages","meals","snacks","dairy","bakery"],
   "escrowCurrency":"USDC",
   "valuation":{"parValue":"1","currency":"INR","region":"IN","compliance":"RBI"}}'::JSONB, 'active')
-- config:
('01938000-0000-7000-8000-00000000002a'::UUID, 'SODEXO-MV', '01938000-0000-7000-8000-00000000001a'::UUID, 'purpose-bound-voucher',
 '[{"hookId":"validation","priority":1,"enabled":true},
   {"hookId":"credential-verification","priority":10,"enabled":true,"operations":["issue"]},
   {"hookId":"logging","priority":20,"enabled":true}]'::JSONB,
 '[{"hookId":"logging","priority":1,"enabled":true}]'::JSONB, '{}'::JSONB,
 '{"stateCommitmentAlgorithm":"sha256","includeDataInCommitment":true,
   "voucherTransfer":{"enabled":false},
   "credentialVerification":{"requiredCredentials":["KYC-BASIC"],"additionalStatesKey":"beneficiary_credentials"},
   "additionalStateRequirements":[
     {"key":"beneficiary_credentials","tokenClass":"CREDENTIAL","ownerFrom":"payload.to","operations":["issue"],"multiple":true,"filters":null},
     {"key":"redeemer_credentials","tokenClass":"CREDENTIAL","ownerFrom":"initiator","operations":["redeem"],"multiple":true,"filters":null}]}'::JSONB, 'active')
```

**LOAN-POOL**:
```sql
('01938000-0000-7000-8000-000000000039'::UUID, 'LOAN-POOL', 'UNITS-LoanPool', 'Loan Pool',
 'Non-fungible token representing a securitisation pool of loans (PTC, DA, or other structures). …',
 '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object",
   "properties":{ "pool_ref_id":{"type":"string"},
     "pool_type":{"type":"string","enum":["PassThroughCertificate","DirectAssignment"]},
     "loan_token_ids":{"type":"array","items":{"type":"string"}}, "loan_count":{"type":"integer","minimum":1},
     "originator_id":{"type":"string"}, "trustee_id":{"type":"string"}, "investor_id":{"type":"string"},
     "cutoff_date":{"type":"string","format":"date"}, "total_pool_amount":{"type":"number"}, "…":"…",
     "fldg":{"type":"number"}, "dpd_bucket_distribution":{"type":"object"}, "current_rating":{"type":"string"},
     "closure_date":{"type":"string","format":"date"}, "closure_reason":{"type":"string"} },
   "required":["pool_ref_id","pool_type","loan_token_ids","loan_count","originator_id","cutoff_date","total_pool_amount"],
   "additionalProperties":false}'::JSONB,
 '[{"id":"realassets-admin","type":"Issuer"}]'::JSONB,
 '{"fungible":false,"symbol":"LOAN-POOL","category":"loan-pool","transferable":false,"divisible":false,
   "burnable":false,"revocable":false,"soulbound":true,"valueCurrency":"INR",
   "allowedMinters":["realassets-admin"],
   "valuation":{"parValue":null,"currency":"INR","region":"IN","compliance":"RBI-SEBI"}}'::JSONB, 'active')
-- config:
('01938000-0000-7000-8000-000000000049'::UUID, 'LOAN-POOL', '01938000-0000-7000-8000-000000000039'::UUID, 'loan-pool-nft-program',
 '[{"hookId":"logging","priority":20,"enabled":true}]'::JSONB,
 '[{"hookId":"logging","priority":20,"enabled":true}]'::JSONB, '{}'::JSONB,
 '{"stateCommitmentAlgorithm":"sha256","includeDataInCommitment":true,"includeRelationshipsInCommitment":true,
   "additionalStateRequirements":[{"key":"loan_tokens","tokenClass":"LOAN-NFT",
     "tokenIdsFrom":"payload.loan_token_ids","operations":["mint"],"multiple":true}]}'::JSONB, 'active')
```
(The seed schema is **wrong for the program**: it types money as `number` and uses `fldg`, but the program needs strings and the key `FLDG`. Since the schema isn't enforced, follow the program. The description's mention of a "LoanDependencyHook" is stale.)

---

## 8. Reading classes, configs and programs

```json
POST /v1/tokenclass/get            {"context":{"id":"api.tokenclass.get",…},       "payload":{"tokenClass":"ACME-PTS"}}
POST /v1/tokenclass/search         {"context":{"id":"api.tokenclass.search",…},    "payload":{"filters":{"tokenStandard":"UNITS-FT"},"pagination":{"limit":50,"offset":0},"sortBy":{"field":"created_at","order":"desc"}}}
POST /v1/tokenclassconfig/get      {"context":{"id":"api.tokenclassconfig.get",…}, "payload":{"tokenClass":"ACME-PTS"}}
POST /v1/tokenclassconfig/search   {"context":{"id":"api.tokenclassconfig.search",…},"payload":{"filters":{"programId":"fungible"},"pagination":{"limit":50,"offset":0}}}
POST /v1/tokenprogram/get          {"context":{"id":"api.tokenprogram.get",…},     "payload":{"programId":"loan-nft-program"}}
POST /v1/tokenprogram/search       {"context":{"id":"api.tokenprogram.search",…},  "payload":{"filters":{},"pagination":{"limit":50,"offset":0}}}
```
- Responses: `get` returns the object in `response`. `search` returns `{"tokenClasses":[…]}`, `{"tokenClassConfigs":[…]}` or `{"tokenPrograms":[…]}`, plus `pagination {total, limit, offset}`.
- Class `get` lookups are upper-cased. Class reads need only `tokenClasses:view`, so you can read **any** class, including other organisations' classes.
- `tokenprogram/search` is the **authoritative live list** of programs, operations and standards on that instance. The engine self-registers at boot, and `config.primitiveCapabilities` and `config.plans` appear there.
- Search filters accept column names (`tokenClass`, `tokenStandard`, `status`, `programId`). Dotted `metadata.<key>` filters are documented in the spec but unverified.

---

## 9. Updating, ownership, naming and versioning

### 9.1 Update a class

```json
POST /v1/tokenclass/update
{"context":{"id":"api.tokenclass.update","version":"1.0","ts":"…","msgId":"…","developerToken":"<DEV_TOKEN>","authorization":"Bearer <OPERATOR_JWT>"},
 "payload":{"tokenClass":"ACME-PTS",
            "description":"Loyalty points. 1 point = 0.01 INR.",
            "metadata":{"decimals":2,"symbol":"APTS","fungible":true,"category":"utility","transferable":true,
                        "divisible":true,"burnable":true,"revocable":false,"soulbound":false,
                        "maxSupply":"20000000000","minBalance":"0"}}}
```
- You need `manage` on the class: an `owner` identity on it, or a `manage` delegation. Scope `tokenClasses:manage`. Otherwise `403 FORBIDDEN`.
- Only fields you send are changed. However, **`metadata`, `schema` and `identities` are replaced whole**, so always resend the full metadata object. Leaving out `decimals` sets it to 0 and silently rescales display amounts.
- Changing `identities` re-hashes ids and propagates to the config.
- **Don't change `tokenStandard`** after tokens exist. Existing tokens keep their stored standard and would then mismatch the class.
- **Changing `decimals` after minting is dangerous.** Stored balances are raw integers, so every display value shifts.

### 9.2 Update a config

```json
POST /v1/tokenclassconfig/update
{"context":{"id":"api.tokenclassconfig.update","version":"1.0","ts":"…","msgId":"…","developerToken":"<DEV_TOKEN>","authorization":"Bearer <OPERATOR_JWT>"},
 "payload":{"tokenClass":"ACME-PTS",
            "preHooks":[{"hookId":"max-supply","priority":5,"enabled":true,"operations":["mint"]},
                        {"hookId":"validation","priority":10,"enabled":true},
                        {"hookId":"logging","priority":20,"enabled":true}]}}
```
- Arrays and objects are **replaced whole**: resend the full hook list.
- `{"tokenClass":"ACME-PTS","status":"suspended"}` halts every operation on the class (async `CONFIG_NOT_FOUND`). Set `"active"` to resume.
- Changing `programId` on a class that already has tokens is **unsupported in practice**. The new program will see token data shaped for the old one. Create a new class instead.

### 9.3 Ownership rules (summary)

1. **Whoever registers the class owns it** (`owner` + `issuer` stamped). Register every class with **one operator account** that your organisation controls: a real UNITS user account (OTP login) whose plaintext address and hash you have recorded.
2. Only class issuers may `/token/mint`. Anyone with a token identity may view that token. The token's `owner` may transact. Other people need delegations (`tokens:tokenclass:<CLASS>` with `view`, `transact` or `manage`).
3. `/token/add` (credentials and proxies) is developer-token-only for sessionless issuance; the token's `owner` is the address hash you pass. Verifiers should validate credential provenance (`token-programs.md` §6.3).
4. To hand a class to another account, update `identities` to include their plaintext address as `owner` and `issuer`, then confirm before removing your own.
5. Seeded owned classes (`LOAN-NFT`, `LOAN-POOL`) belong to `realassets-admin`. You can't mint into them.

### 9.4 Naming

- Use `ORG-PURPOSE` in upper case: `ACME-PTS`, `ACME-LOAN`, `ACME-KYC`. Keep to `[A-Z0-9-]`. Lower-case input is upper-cased. Never seed mixed-case rows directly (that's the `USDe`/`crvUSD` bug).
- Class keys are **global per instance and permanent**. There is no delete endpoint. Prefix with your organisation to avoid `409`.
- For test runs on sanctum, add a suffix (`ACME-PTS-T1`), because you can't delete classes.

### 9.5 Versioning

There are **no versions** on classes or configs; changes are in-place updates. Programs have a `version` string, but you can't pin one. So:
- **Freeze the schema and metadata early.** Treat `tokenStandard`, `programId`, `decimals` and the `data` shape as immutable once real tokens exist.
- For a breaking change, register a **new class** (`ACME-LOAN-V2`) and migrate going forward.
- Changing commitment settings is safe: old state-history rows keep the config they were hashed with.

### 9.6 Idempotent setup (recommended)

```
for each class:
  r = POST /v1/tokenclass/get {tokenClass}
  if r ok        → classId = r.response.id
  else (404)     → classId = POST /v1/tokenclass/register {...}.response.id
  c = POST /v1/tokenclassconfig/get {tokenClass}
  if c 404       → POST /v1/tokenclassconfig/register {tokenClass, tokenClassId: classId, programId, ...}
  else if c.response.programId != expected → alert (someone else configured it)
```

---

## 10. Common mistakes and their errors

| Mistake | What you see | When | Fix |
|---|---|---|---|
| Class registered, no config | `400 INVALID_INPUT: primitive_capability_missing` | sync, on mint/transact | `tokenclassconfig/register` |
| `programId` typo or old name (`reference-ft`, `loan-nft`, `nfh-voucher`) | `400 primitive_capability_missing` | sync, first operation | use the live ids (§4.1) |
| `tokenStandard` not on the program whitelist (e.g. `UNITS-FT` on `credential`, `UNITS-LOAN-POOL`) | `failed` + `UNSUPPORTED_TOKEN_STANDARD` | **async** (poll) | update the class `tokenStandard` before any tokens exist, or register a new class |
| Wrong case in standard (`units-ft`) | `UNSUPPORTED_TOKEN_STANDARD` | async | exact case |
| Duplicate class key | `409 CONFLICT "Token class already exists"` | sync | `get` first; choose a unique key |
| Second config for the class | `409 CONFLICT` | sync | `tokenclassconfig/update` |
| Mint from an account that isn't a class issuer | `403 FORBIDDEN "user is not authorized to mint tokens for this class"` | sync | mint as the operator that registered it |
| Sending `identities[]` on mint | mint completes; the **next transact** gives `FORBIDDEN: no_matching_allow_rule` | delayed | never send identities on mint |
| Identity `type` outside `issuer, creator, owner, co-owner, operator, viewer, access` (e.g. `borrower`, `lender`) | `INVALID_PAYLOAD: unknown variant` | async | use the allowed types; put roles in `data` |
| Class identities given as DID or hash of something else | Nobody can mint (`403`) | sync | plaintext address (`"acme-ops"`) or the exact sha256 hash |
| `fungible` missing on an NFT, loan or pool class | Engine treats it as per-owner fungible on mint (it may reuse an existing token or demand Issuer/Owner identities) | async, odd results | set `"fungible": false` |
| Hook id typo (`max_supply`, `minBalance`) | none: the hook is **silently skipped** | — | use exact ids (§3.2); check the engine logs |
| `min-balance` configured, burn without `value` | `INVALID_PAYLOAD "Could not determine operation value for minBalance check"` | async | always send `value` |
| `min-balance` without `lock` in operations | transfers bypass the floor | silent | include `"lock"` |
| `maxSupply` given as a display value (`"1000000.00"`) | the hook can't parse it, or the cap is 100× wrong | async | raw integer string |
| Expecting `schema` to validate `data` | bad data is accepted (or rejected later by the program) | — | validate client-side; the program is the validator |
| Expecting `operationOverrides` or `burnable:false` to block an operation | the operation runs | — | rely on program support and delegations |
| Mixed-case seeded class (`USDe`) | `404 Token class not found` | sync | unreachable; use another class |
| Voucher mint on `purpose-bound-voucher` | `failed` + `CAPABILITY_DENIED … domain_lifecycle` | async | blocked; use the fungible workaround (§6.7) |
| Loan field as a number (`"loanAmount": 500000`) or with decimals (`"12.5"`) | `INVALID_PAYLOAD: Invalid LoanOriginatedPayload: invalid type…` or `invalid digit found in string` | async | integer **strings** for u128 |
| `foir: "0"` | `foir must be in (0, 1], got 0` | async | `"1"`…`"10000"` |
| Pool fields in camelCase | `INVALID_PAYLOAD: Invalid MintPayloadData: missing field pool_ref_id` | async | snake_case, plus `FLDG` |
| Proxy `contractAddress` not in `contractIds[chainId]` | `400 "contractAddress does not match registered contract for X on Y"` | sync | add the chain to class `metadata.contractIds` (update), or use the right address |
| Updating metadata with a partial object | other keys (e.g. `decimals`) wiped | silent | send the full metadata |
| Polling a `/token/add` tx with the operator session | `403 "not authorized to access this transaction"` | sync | poll with the holder's session |

---

## 11. Checklist before you mint for real

- [ ] The operator account exists; you stored its plaintext address and `sha256(lower(trim(address)))`.
- [ ] `tokenclass/get` shows your class: `tokenStandard` is correct, `identities` contains your hash as owner and issuer, and `metadata.decimals` and `fungible` are set.
- [ ] `tokenclassconfig/get` shows the right `programId`, `status:"active"`, and the hooks you expect (exact ids).
- [ ] `tokenprogram/get {programId}` lists the operations you plan to call, and your `tokenStandard` is in `supportedStandards`.
- [ ] A test mint or add on sanctum reached `completed`, and you resolved its tokenId.
- [ ] Your client sends `valueFormat` explicitly, uses a fresh `msgId` per attempt, and dedupes on your own business ids.
