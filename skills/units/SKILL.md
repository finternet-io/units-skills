---
name: units
description: Expert knowledge of UNITS, the ledger and tokenisation platform of Finternet (a mission of Networks for Humanity, NFH). Use whenever someone asks about UNITS or Finternet — the web portals (my./sanctum./foundry.finternetlab.io), signing up and getting developer tokens via API Access, scopes, integrating as an external partner, the request envelope, OTP login, defining token classes, configs and token programs (fungible, non-fungible, credential/KYC, stables proxies, vouchers, loan-nft, loan-pool), minting, adding credentials, transacting (transfer, burn, freeze, lock, loan ops), polling transaction status, proofs, delegations, error codes and troubleshooting, designing tokenisation use cases (loans, securitisation, credentials, vouchers), writing a new Rust token program or hook, Restate workflows, or running UNITS locally. Not for deployment/infra (helm, terraform).
---

# UNITS skill

UNITS ("Unified Information Tokenisation System", sometimes written "Universal") is the ledger of **Finternet**, a mission of **Networks for Humanity (NFH)**. It holds **tokens**: typed, owned, hash-chained records of value, assets, or claims. Every state change runs through a **token program** (Rust business logic) that the token's **token class** is bound to. Instances are federated. Every account has one home instance, and a central registry handles routing, developer credentials and delegations.

This file contains the mental model, the rules that matter most, and a map of the reference files. **Load the matching reference before you answer anything detailed.** The references hold exact payloads, field lists and errors. Don't answer field-level questions from memory.

Knowledge snapshot: **2026-10-03**. It was compiled from the UNITS source code, specifications and public docs, plus hands-on testing against the sanctum sandbox. Where live behaviour and code disagree, the references say so. For anything that may have changed, tell the user to verify against their instance (e.g. `POST /v1/tokenclassconfig/get`, `/v1/tokenprogram/search`).

## Who is asking? Route first

| Asker / question | Start with |
|---|---|
| "What is UNITS / Finternet? Is it a blockchain? What's a token?" | `references/concepts.md` |
| "Which website / portal? How do I sign up and get a developer token / API key? Which scopes?" | `references/portals-and-access.md` |
| "How do I integrate / authenticate?" (external partner) | `references/integration-playbook.md`, then `references/auth-and-onboarding.md` |
| "What does endpoint X take / return? What does error Y mean?" | `references/api-reference.md`, `references/troubleshooting.md` |
| "How do I define a token class / config / program for my use case?" | `references/token-classes.md` + `references/token-programs.md` |
| "Show me a full example for loans / credentials / vouchers / stablecoins / securitisation" | `references/worked-examples.md` + `examples/` |
| "How do I build a new token program or hook?" (engineer) | `references/authoring-token-programs.md` |
| Workflows, sagas, registry, proofs, OTP, adapters internals | `references/workflows-and-services.md`, `references/architecture.md` |
| Run / test / debug the stack locally | `references/local-development.md` |
| "Does UNITS support X yet?" / limitations | `references/known-gaps.md` |
| Quick Q&A | `references/faq.md` |

Runnable code: `examples/units-client.ts` (Node 20+, no dependencies), `examples/units_client.py`, `examples/quickstart.sh` (curl + jq), and `examples/token-classes/*.json` (ready-made class and config payloads).

## The mental model in five lines

1. **Token class** is the *type* of a token, e.g. `ACME-PTS`, `LOAN-NFT`, `USDC`. It has a key, a `tokenStandard`, a name, a JSON `schema` (documentation only, not enforced by the API), `identities` (who may mint) and `metadata` (decimals, symbol, policy flags). It's registered with `POST /v1/tokenclass/register`.
2. **Token class config** *binds* the class to a program and sets engine behaviour: `programId`, pre/post `hooks`, `config` (commitment algorithm, cross-token state requirements, and so on). It's registered with `POST /v1/tokenclassconfig/register`. **Without it every operation fails** with `primitive_capability_missing`.
3. **Token program** is the *code* (Rust `TokenProgram` trait in the token engine) that decides which operations exist and how state changes. External integrators **choose** a program; they can't upload one. Live programs: `fungible`, `non-fungible`, `credential`, `stables`, `purpose-bound-voucher`, `loan-nft-program`, `loan-pool-nft-program` (plus `hello-token` as an example).
4. **Token** is an *instance* of a class. It has `metadata`, `data` (program-specific), `identities` (owner, issuer, …), `relationships`, `state` (balance, supply, status, locks) and a chained `stateCommitment`.
5. **Operations** go through `/v1/token/mint` (create), `/v1/token/add` (import a credential or on-chain proxy), and `/v1/token/transact` (everything else: transfer, burn, freeze, lock, `loan_disbursed`, …). They are **asynchronous**: you get a `txId` back and poll for the result.

```
token_classes ──(1:1)── token_class_configs ──programId──► token_programs (Rust, in engine)
      ▲                                                        │ executes ops
      │ tokenClass                                             ▼
   tokens ◄── /v1/token/mint | /v1/token/add | /v1/token/transact ──► transactions (poll txId)
```

## Rules that prevent most integration failures

1. **Envelope, not headers.** Every call is `POST /v1/...` with this body:
   `{"context":{"id":"api.token.mint","version":"1.0","ts":"<RFC3339>","msgId":"<uuid>","developerToken":"<dev token>","authorization":"Bearer <user JWT>","valueFormat":"raw"},"payload":{...}}`.
   Credentials go **in the body**; the `Authorization` HTTP header is ignored. `context` rejects unknown keys. Read results from `response`, and read errors from `context.error {code,message}`.
2. **Two credentials.** The *developer token* `base64("sa-<clientUuid>:<secret>")` identifies your app and goes on every call. **Self-serve it** in the web portal (`sanctum.finternetlab.io` / `my.finternetlab.io`) → **API Access → Register client**. The secret is shown once. Calling `/v1/clients/register` directly needs a superadmin, so use the portal or email engineering@finternetlab.io. The *user JWT* comes from OTP login and is needed for almost everything except `/v1/token/add` and login itself.
3. **Identity = `sha256(lower(trim(address)))` hex**, which equals the JWT `preferred_username`. It is **not** the DID. `account/get` masks the address, so **store the plaintext address and its hash at signup**. Use the plaintext address in `to`, delegations and class identities. Use the hash as `owner` in `/v1/token/add`.
4. **Registering a class takes two synchronous calls**: `tokenclass/register`, then `tokenclassconfig/register {tokenClass, tokenClassId, programId, preHooks:[]}`. The `tokenStandard` must be on the program's whitelist (e.g. `fungible` accepts `UNITS-FT`), or ops fail **at poll time** with `UNSUPPORTED_TOKEN_STANDARD`. Set `metadata.fungible` to `false` for non-fungible, loan, pool and credential classes. The engine treats a class as fungible when this flag is absent.
5. **Whoever registers a class owns it.** Use one **operator account** (a real UNITS user account owned by your organisation) for class registration and platform writes. End users own their own credentials.
6. **Never send `identities[]` on mint.** The engine fills in issuer and owner itself. Ids you supply get re-hashed and you lose rights (`FORBIDDEN: no_matching_allow_rule` on the next transact).
7. **All writes are async.** mint, add and transact return `{txId, status:"submitted"}` with **no tokenId**. Poll `POST /v1/transaction/status {txId}` with the initiator's or owner's session until the status is `completed`, `failed` or `cancelled`. Most validation errors only show up there. Then get the tokenId from `/v1/transaction/get` → `metadata.token_id`, then `metadata.affectedTokenIds[0]`, then legacy `responseData.tokenId|id`; fall back to `/v1/token/search` on your business id. **There are no webhooks.**
8. **Amounts are strings.** Set `context.valueFormat` explicitly on token get/search/mint/transact (other endpoints with a closed context reject it). `raw` means base-unit integers. `display` means decimals scaled by the class's `metadata.decimals`, and the code defaults to `display`. Generic ops use the field `value`, never `amount`. Loan ops also use `value` in current code; older builds (Aug 2026) took `amount`. Loan u128 fields are integer strings, u32 fields are JSON numbers, and send `foir` as `"1"`.
9. **`/v1/token/transact` may require `signature: {keyId, jws}`.** This is a raw Ed25519 signature (std base64) over the RFC 8785 JCS bytes of `payload`, made with a key registered through `/v1/account/keys/register`. It's environment-dependent (sanctum accepted unsigned calls in Aug 2026), so build it in anyway.
10. **Use fresh `msgId` per attempt; there is no idempotency key.** Retries can duplicate mints, so dedupe on your own business IDs (loanRefId, orderReference).

## Environments

| Env | Web portal (sign up, API Access → developer tokens) | API base (your code calls this) | Notes |
|---|---|---|---|
| Sanctum (staging / integrator sandbox) | https://sanctum.finternetlab.io | `https://units.sanctum.finternetlab.io` | Email/phone OTP + Google login; OTP `123456` accepted; scheduled weekdays 08:00–21:00 IST |
| Production | https://my.finternetlab.io | `https://units.finternetlab.io` | Portal is Google SSO only; real OTPs; older build than sanctum |
| Foundry (dev) | https://foundry.finternetlab.io | `https://units.foundry.finternetlab.io` | Internal; may be down |
| Local | — | `http://localhost:3000` | See `references/local-development.md` |

Credentials, accounts and token classes are **per environment**. Don't invent other hostnames. Public docs: `docs.finternetlab.io`. Support: engineering@finternetlab.io and Discord. Full portal guide: `references/portals-and-access.md`.

## Choosing a program (short version — full guide in token-classes.md)

| Need | programId | tokenStandard | Create with | Status |
|---|---|---|---|---|
| Points, units, deposits, fungible balances | `fungible` | `UNITS-FT` | `/token/mint` | Works; one token per owner (mints top up the minter's token; customers get tokens only by transfer). Cross-account `transfer` failed on sanctum (`recipient_address_not_found`) |
| Unique asset (NFT) | `non-fungible` | `UNITS-NFT` | `/token/mint` (`initialSupply:"1"`) | In code; not discoverable on sanctum in Aug 2026 (check `/v1/tokenprogram/search`) |
| KYC or any attestation (soulbound VC) | `credential` | `UNITS-CREDENTIAL` | `/token/add` (no user JWT; `owner` = address hash) | Works live. Revoke/suspend need the holder's session or a delegation; verifiers should check provenance (`token-programs.md` §6.3) |
| Loan account lifecycle | `loan-nft-program` | `UNITS-Loan` | `/token/mint` (= `loan_originated`) then `transact` domain ops | Works live |
| Securitisation pool | `loan-pool-nft-program` | `UNITS-LoanPool` | `/token/mint` (snake_case fields) | In code; not exercised live |
| Mirror of on-chain USDC/ETH/… | `stables` | `PROXY-FT` | `/token/add` with chainId/contract/wallet | Works for seeded classes |
| Purpose-bound, category-capped voucher | `purpose-bound-voucher` | `UNITS-SFT` | — | **Blocked**: `CAPABILITY_DENIED` on mint/issue/redeem in current builds |

Need something else (warehouse receipt, bond, lien-carrying asset)? Custom programs are Rust work done by Finternet engineering. Give them the operations, payloads and state machine you need (`references/authoring-token-programs.md`). Until then, model with what exists, for example a lien as `cersai_registered` on a LOAN-NFT.

## How to answer well

- **Be precise and copy-pasteable.** Give full JSON envelopes with the correct `context.id` (`api.<group>.<action>`), not fragments.
- **Be honest about status.** Separate what is *live-verified*, what is *in code*, and what is *design or roadmap*. UNITS is a Postgres-backed ledger with hash-chained state commitments, not a blockchain. Merkle batch proofs often read `pending`, on-chain anchoring is roadmap, and `proof/verify` is structural only.
- **Flag stale sources.** Older docs mention `Authorization: Bearer` header auth, `/v1/api-clients`, `/v1/token/transfer`, program ids like `reference-ft`/`nfh-voucher`, `entityType: "Individual"`, `amount` in transact. Correct these when a user quotes them (`references/troubleshooting.md` has the truth table).
- **Never ask for or echo secrets.** Developer tokens and JWTs belong server-side only, never in browser bundles.
- **Deployment and infrastructure** (helm, terraform, cluster ops) are out of scope for this skill.
