# `examples/token-classes/`: ready-made token class payloads

Seven example token classes, one per UNITS token program. Each file holds the **two payloads** you send to set up a class:

1. `POST /v1/tokenclass/register`: defines the class (the *type* of token)
2. `POST /v1/tokenclassconfig/register`: binds the class to a **token program** and configures hooks

Without step 2, every mint or transact fails with `INVALID_INPUT: primitive_capability_missing`.

Snapshot: 2026-10-03. Full explanations of every field are in [`../../references/token-classes.md`](../../references/token-classes.md), and the program operations are in [`../../references/token-programs.md`](../../references/token-programs.md).

---

## File format

```jsonc
{
  "_about":  "Human notes: what the class is for, caveats, links. NOT sent to the API.",
  "register": { /* payload for /v1/tokenclass/register */ },
  "config":   { /* payload for /v1/tokenclassconfig/register */ }
}
```

- **Only `register` and `config` are sent.** `_about` is documentation.
- `config.tokenClassId` contains the placeholder `"<tokenClassId from tokenclass/register response.id>"`. Replace it with the `response.id` returned by the register call. `ensureTokenClass()` in both example clients does this for you.
- **Rename the `ACME-` prefix** before use. Class names are global across all tenants on an instance, and the server upper-cases them.
- `schema` is **documentation only**. UNITS doesn't enforce class schemas; the program validates `data`.
- `metadata.fungible` must be `false` for every non-fungible-balance class (NFT, credential, loan, pool, voucher). The engine assumes fungible when it's absent.

## The seven classes

| File | Class | `tokenStandard` | `programId` | Pre-hooks | Notable `config` keys | How tokens are created | Status (2026-10) |
|---|---|---|---|---|---|---|---|
| [`acme-pts.fungible.json`](acme-pts.fungible.json) | ACME-PTS: loyalty points, 2 decimals, `maxSupply` | `UNITS-FT` | `fungible` | max-supply, validation, logging | `stateCommitmentAlgorithm` | `/token/mint` | ✅ mint works; ⚠️ transfer to other users failed on sanctum (`recipient_address_not_found`) |
| [`acme-kyc.credential.json`](acme-kyc.credential.json) | ACME-KYC: soulbound KYC credential (W3C VC) | `UNITS-CREDENTIAL` | `credential` | validation, logging | `stateCommitmentAlgorithm` | `/token/add` (credential branch; dev token only, `owner` = address hash) | ✅ verified live |
| [`acme-loan.loan-nft.json`](acme-loan.loan-nft.json) | ACME-LOAN: one token per loan account | `UNITS-Loan` | `loan-nft-program` | logging | `stateCommitmentAlgorithm` | `/token/mint` (= `loan_originated`), then 21 domain ops via `/token/transact` | ✅ verified live |
| [`acme-asset.non-fungible.json`](acme-asset.non-fungible.json) | ACME-ASSET: unique asset NFT | `UNITS-NFT` | `non-fungible` | validation, logging | `stateCommitmentAlgorithm` | `/token/mint` with `initialSupply:"1"` | ⚠️ in code; was not discoverable on sanctum in Aug 2026, so check `/v1/tokenprogram/search` |
| [`acme-usdc.proxy.json`](acme-usdc.proxy.json) | ACME-USDC: proxy of on-chain USDC, 6 decimals, `contractIds` | `PROXY-FT` | `stables` | validation, logging | `stateCommitmentAlgorithm` | `/token/add` (proxy branch: `chainId`, `contractAddress`, `walletAddress`, `value`) | ✅ code path exists; usually just use the seeded `USDC` class |
| [`acme-pool.loan-pool.json`](acme-pool.loan-pool.json) | ACME-POOL: securitisation pool over loan tokens | `UNITS-LoanPool` | `loan-pool-nft-program` | logging | `additionalStateRequirements` (loads constituent loan tokens) | `/token/mint` (snake_case `data`) | ⚠️ in code; not exercised live |
| [`acme-voucher.purpose-bound.json`](acme-voucher.purpose-bound.json) | ACME-VOUCHER: category-capped voucher, credential-gated issue | `UNITS-SFT` | `purpose-bound-voucher` | validation, credential-verification, logging | `voucherTransfer`, `credentialVerification`, `additionalStateRequirements` | `/token/mint` then `issue`/`redeem` | ❌ **blocked**: `CAPABILITY_DENIED` on current builds (kept as the reference design) |

## How to use them

### With the TypeScript client

```ts
import { UnitsClient } from "../units-client.ts";
import kyc from "./acme-kyc.credential.json" with { type: "json" };

const units = new UnitsClient({ baseUrl: process.env.UNITS_BASE_URL!, developerToken: process.env.UNITS_DEVELOPER_TOKEN! });
// operatorJwt = session of YOUR operator account (whoever registers the class owns it)
await units.ensureTokenClass(kyc, operatorJwt);   // get → register → get config → register config (idempotent)
```

### With the Python client

```python
import json
from units_client import UnitsClient
units = UnitsClient(BASE_URL, DEVELOPER_TOKEN)
units.ensure_token_class(json.load(open("token-classes/acme-loan.loan-nft.json")), operator_jwt)
```

### By hand with curl + jq

```bash
F=acme-pts.fungible.json
ctx() { jq -n --arg id "$1" --arg dt "$UNITS_DEVELOPER_TOKEN" --arg jwt "Bearer $OPERATOR_JWT" \
  '{id:$id, version:"1.0", ts:(now|todate), msgId:("'$(uuidgen | tr A-Z a-z)'"), developerToken:$dt, authorization:$jwt}'; }

# 1) register the class → capture response.id
CLASS_ID=$(jq -n --argjson c "$(ctx api.tokenclass.register)" --argjson p "$(jq .register $F)" '{context:$c, payload:$p}' \
  | curl -s "$UNITS_BASE_URL/v1/tokenclass/register" -H 'Content-Type: application/json' -d @- | jq -r .response.id)

# 2) register the config with that id
jq -n --argjson c "$(ctx api.tokenclassconfig.register)" --argjson p "$(jq --arg id "$CLASS_ID" '.config | .tokenClassId=$id' $F)" \
  '{context:$c, payload:$p}' \
  | curl -s "$UNITS_BASE_URL/v1/tokenclassconfig/register" -H 'Content-Type: application/json' -d @- | jq .
```

Both calls are **synchronous**; you don't need to poll. Generate a fresh `msgId` for each call. The `ctx` helper above creates one each time it is invoked.

## Customising a class

| You want to… | Change |
|---|---|
| Rename it | `register.tokenClass` **and** `config.tokenClass` (both must match) |
| Change decimals | `register.metadata.decimals`. It controls `valueFormat: "display"` conversion. Freeze it before the first mint. |
| Cap supply | `register.metadata.maxSupply` (integer string, base units) + `max-supply` pre-hook on `["mint"]`. The cap is per issuer token. |
| Enforce a minimum balance | `register.metadata.minBalance` + `min-balance` pre-hook on `["transfer","burn","lock","debit"]`. Every burn and lock must then carry `value`. |
| Restrict who may mint | `register.identities: [{"id":"<plaintext address>","type":"issuer"}]`. Omitting it (or `[]`) stamps the registering caller as owner+issuer. |
| Use blake3 commitments | `config.config.stateCommitmentAlgorithm: "blake3"` |
| Gate an operation on the holder owning a credential | `config.config.additionalStateRequirements` + `credential-verification` hook. See the voucher file and `token-classes.md` §3. |

Hook ids the engine knows: `validation`, `logging`, `max-supply`, `min-balance`, `credential-verification`. **An unknown `hookId` is skipped silently**, so check spelling.

## Validate the files

```bash
for f in *.json; do python3 -m json.tool "$f" >/dev/null && echo "ok  $f" || echo "BAD $f"; done
```

## Common mistakes

| Mistake | Symptom |
|---|---|
| Forgetting the config call | `INVALID_INPUT: primitive_capability_missing` on first op |
| `tokenStandard` not on the program's whitelist (e.g. `UNITS-NFT` on `fungible`) | Async `UNSUPPORTED_TOKEN_STANDARD` at poll time |
| Typo in `programId` | Config register succeeds (it isn't validated); first op fails |
| Registering with one account, minting with another | `FORBIDDEN` (whoever registers owns the class; use one operator account) |
| Sending `identities[]` on mint | Mint completes, next transact fails with `FORBIDDEN: no_matching_allow_rule` |
