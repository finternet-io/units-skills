# `units` skill: guide for humans

This folder **is the skill**: what gets zipped for Claude.ai and auto-loaded by the Claude Code plugin. Claude reads `SKILL.md` first and then opens files in `references/` and `examples/` as questions require. This README is for people browsing or maintaining the skill; Claude doesn't need it.

**UNITS** ("Unified Information Tokenisation System") is the federated ledger of **Finternet**, a mission of **Networks for Humanity (NFH)**. It holds tokens (typed, owned, hash-chained records of value, assets or claims) whose state changes are executed by Rust **token programs** bound to **token classes**.

Snapshot: **2026-10-03**. Scope: everything except deployment and infrastructure.

---

## Folder map

```
units/
├── SKILL.md          Entry point Claude always reads when triggered
├── README.md         This file
├── references/       15 deep reference files; see references/README.md
└── examples/         Runnable clients + token class payloads; see examples/README.md
```

## What's in `SKILL.md`

| Section | Purpose |
|---|---|
| Frontmatter `description` | The trigger. It lists UNITS/Finternet topics so Claude activates the skill, and excludes deployment. |
| "Who is asking? Route first" | Table mapping question types to the reference file Claude should open |
| "The mental model in five lines" | Token class → config → program → token → operations, with a binding diagram |
| "Rules that prevent most integration failures" | 10 rules that address almost every real-world failure seen on the live sandbox |
| "Environments" | Sanctum (sandbox), production, foundry (dev), local, with API base URLs |
| "Choosing a program" | Need → `programId` / `tokenStandard` / how to create / live status |
| "How to answer well" | Tone and honesty rules: precise JSON, live vs code vs roadmap, flag stale docs, never echo secrets |

The 10 rules, in brief:
1. Credentials go in the JSON envelope, not HTTP headers.
2. Two credentials are needed: the developer token and the user JWT.
3. Identity is `sha256(lower(trim(address)))`, not the DID. Store it at signup.
4. Registering a class takes two calls (class + config). `tokenStandard` must be whitelisted, and `metadata.fungible:false` must be set for non-fungibles.
5. Whoever registers a class owns it, so use one operator account.
6. Never send `identities[]` on mint.
7. All writes are async: poll `/v1/transaction/status`, then resolve the tokenId. There are no webhooks.
8. Amounts are strings. Set `valueFormat` explicitly (token endpoints only). Use `value`, not `amount`.
9. `/v1/token/transact` may need an Ed25519 signature over JCS(payload).
10. Use a fresh `msgId` per attempt. There's no idempotency key, so dedupe on business ids.

## Suggested reading order

**External integrator (first day):**
1. `SKILL.md`
2. `references/portals-and-access.md`: portals, sign-up, getting your developer token
3. `references/integration-playbook.md`: the step-by-step guide
4. `references/auth-and-onboarding.md` §2–§5: credentials, signup, hashing
5. `references/token-classes.md` §1, §4, §6: model, choosing a program, worked examples
6. `examples/quickstart.sh`: first round trip against the sandbox
7. `references/known-gaps.md` §1: what will bite you

**Designing a use case:** `concepts.md` → `token-classes.md` → `token-programs.md` (your program's section) → `worked-examples.md` (closest scenario) → `known-gaps.md`

**Engineer joining the UNITS team:** `architecture.md` → `workflows-and-services.md` → `authoring-token-programs.md` → `local-development.md` → `troubleshooting.md` §D

## What questions the skill answers well

- Which portal to use per environment, portal sign-up and pages, self-serve developer tokens (API Access), scopes, environments, OTP
- Exact request/response JSON for any public endpoint
- Defining token classes and configs; choosing programs; hooks; seeded classes
- Every program operation and its payload (fungible, non-fungible, credential, stables, voucher, loan-nft, loan-pool)
- End-to-end designs: livestock-backed loans, securitisation, KYC + consent, loyalty points, stablecoin proxies, vouchers, warehouse receipts
- Error codes, both sync and async, plus a step-by-step debugging procedure
- Writing new token programs and hooks; Restate workflows; registry, proofs, OTP and adapter services
- Running the stack locally and debugging with SQL
- What's not supported yet, and what to claim honestly

## What it deliberately doesn't cover

- Deployment: helm charts, terraform, clusters, CI/CD (`units-automation*` repos)
- Commercial or regulatory onboarding of partners (contracts, pricing, compliance sign-off). Claude refers those to Finternet.
- Secrets. None are included, and Claude is instructed never to ask for or echo them.

## Accuracy conventions used throughout

Every capability is labelled with one of:

| Label | Meaning |
|---|---|
| **live-verified** | Observed working against the sanctum sandbox (Aug 2026) |
| **in code** | Present in source (units-api 2026-09-17, token runtime 2026-07-07) but not exercised live |
| **environment-dependent** | Live and code differ (e.g. transact signature enforcement, loan `value` vs `amount`), or behaviour depends on feature flags |
| **design / roadmap** | Proposed in plans or docs, not implemented |
| **blocked** | Implemented, but fails on current builds (e.g. purpose-bound-voucher mint) |

When sources conflict, precedence is: live behaviour > current code > specs > public docs > older plans. See the root `README.md` §7.

## Maintaining this folder

- Keep `SKILL.md` short. Change it only when a golden rule, route, environment or program status changes.
- Put new detail in the owning reference file; `references/README.md` says which file owns what.
- Keep the examples in sync with the references. If a payload changes, update `token-programs.md`, `examples/token-classes/*.json` and both clients.
- Update the snapshot date in `SKILL.md`, this file and `references/README.md`.
