# `references/`: deep reference library

There are 15 reference files (about 10,000 lines). Claude opens them **on demand**, as routed by `../SKILL.md`. Each file owns one topic, so update facts in the owning file and cross-link from the others.

Snapshot: **2026-10-03**. Precedence when sources disagree: live-verified behaviour > current code > specs > public docs > older plans.

---

## Index

| File | Audience | Owns (source of truth for) | Read it when… |
|---|---|---|---|
| [`portals-and-access.md`](portals-and-access.md) | Integrators (start here) | Web portals per environment (`sanctum.`/`my.`/`foundry.finternetlab.io`), API hosts, portal sign-up (OTP vs Google SSO), portal page tour, **self-serve developer tokens via API Access**, scope presets and picking scopes, rotate/deactivate, moving to prod, Login with Finternet, support contacts | "Which website?", "How do I get an API key?", "Which scopes?" |
| [`concepts.md`](concepts.md) | Everyone | Plain-language model, core objects, token data model, native vs proxy modes, "is / isn't", name changes, **~245-term glossary** | Someone asks "what is X?" or you meet an unfamiliar term |
| [`architecture.md`](architecture.md) | Engineers, architects | Component map, topology, request pipeline, mint/transfer/login/proof data flows, federation, Kafka/outboxes, environments & hostnames, repo map, table ownership, docs-vs-code audit, source snapshot | You need to know how pieces connect or where code lives |
| [`auth-and-onboarding.md`](auth-and-onboarding.md) | Integrators | Developer tokens, partner onboarding, OTP signup/login, identity hashing, sessions & refresh, **envelope signatures (JCS + Ed25519)**, scopes, resource authz, delegations, OIDC sessions, terms/consent, federation, feature flags | Anything about credentials, permissions or signing |
| [`api-reference.md`](api-reference.md) | Integrators, engineers | Envelope spec, conventions, search/pagination/filters, status vocabularies, **full endpoint catalogue**, sync and async error tables, removed/stale endpoints | You need the exact request or response for an endpoint |
| [`token-classes.md`](token-classes.md) | Integrators, designers | Class / config / program / token model, every class and config field, hooks, `additionalStateRequirements`, **choosing `tokenStandard` + `programId`**, 7 worked classes, 27 seeded classes, updating, ownership, naming, common mistakes, pre-mint checklist | You're defining or debugging a token class |
| [`token-programs.md`](token-programs.md) | Integrators, engineers | How an op reaches a program, **every program and every operation with payloads**, state machines, loan field types, error catalogue, "can I write my own program?" | You need an operation's payload or behaviour |
| [`integration-playbook.md`](integration-playbook.md) | External integrators | **Steps 0–8** (prerequisites → client → users → classes → writes → polling → reads → delegations → hardening), go-live checklist, design-arounds | Someone is starting an integration |
| [`worked-examples.md`](worked-examples.md) | Integrators, designers | **7 end-to-end scenarios** with every call's JSON: (A) livestock-backed loan, (B) securitisation, (C) KYC + third-party consent, (D) loyalty points, (E) stablecoin proxy, (F) purpose-bound voucher, (G) CITI warehouse receipt | You want a complete example close to a use case |
| [`authoring-token-programs.md`](authoring-token-programs.md) | UNITS engineers | Program mental model, file checklist, **full `warranty-nft` Rust example**, self-registration, seeding, E2E test, new hooks and config keys, variants, pitfalls, PR checklist | You're building a new program or hook |
| [`workflows-and-services.md`](workflows-and-services.md) | UNITS engineers | Restate workflows (primitive-operation saga, delegation, profile-update), `/v1/workflows/*`, `primitive_ops` outbox, Kafka, scope approval, registry, proofService, otp-service, adapterOrchestrator, keycloakDelegatedAuth, gaps per component | You work on sagas or the supporting services |
| [`local-development.md`](local-development.md) | UNITS engineers | Workspace layout, per-repo commands, running the stack, making token ops complete locally, Postman, **end-to-end debugging SQL**, local failures, contribution conventions | You run, test or debug locally |
| [`troubleshooting.md`](troubleshooting.md) | Everyone | How to read an error, **sync errors**, **async (poll-time) errors**, silent wrong behaviour, stuck-transaction procedure, **"docs say X, reality is Y" truth table** | Something failed, or a user quotes stale docs |
| [`known-gaps.md`](known-gaps.md) | Everyone | Top 12 gaps, gaps by area (API/auth, tokens, proofs, eventing, federation, vouchers, environments), **how to talk about UNITS honestly** | "Does UNITS support X?" or before making claims to customers |
| [`faq.md`](faq.md) | Everyone | **74 short Q&As** (basics, access, identity, classes, writes, use cases, reads/proofs, errors, engineers), each linking to the owning file | Quick answer needed |

## Reading paths

| Goal | Path |
|---|---|
| First integration | `portals-and-access.md` → `integration-playbook.md` → `auth-and-onboarding.md` → `token-classes.md` §4, §6 → `api-reference.md` (as needed) → `troubleshooting.md` |
| Design a tokenised product | `concepts.md` §3–5 → `token-classes.md` §4 → `token-programs.md` (program section) → `worked-examples.md` → `known-gaps.md` |
| Debug a failed transaction | `troubleshooting.md` §0, §B, §D → `api-reference.md` §7 → `local-development.md` §6 (SQL, engineers) |
| Build a new token program | `token-programs.md` §1–2 → `authoring-token-programs.md` → `local-development.md` §4 |
| Understand the platform | `concepts.md` → `architecture.md` → `workflows-and-services.md` |

## Facts every file agrees on

These were settled by checking code and live behaviour. If you change one, grep every file:

| Fact | Value |
|---|---|
| Transport | `POST /v1/...`, JSON envelope `{context, payload, signature?}`; credentials in `context`, not headers; result in `response`, errors in `context.error` |
| Developer token | `base64("sa-<client-uuid>:<secret>")` in `context.developerToken`; per environment |
| User session | `context.authorization: "Bearer <Keycloak JWT>"` from OTP login |
| Identity | `sha256(lower(trim(address)))` hex = JWT `preferred_username` (not the DID) |
| `entityType` | `PERSONAL` \| `BUSINESS` |
| Class register `identities` | omitted **or** `[]` → caller stamped owner + issuer |
| Mint | never send `identities[]`; response has no tokenId |
| tokenId lookup | `transaction/get` → `metadata.token_id` → `metadata.affectedTokenIds[0]` → `responseData.tokenId/id` → fallback `token/search` |
| Amounts | strings; `value` not `amount`; `valueFormat` only on token get/search/mint/transact |
| Loan amounts | `data.value` (current code); `data.amount` on older builds |
| `foir` | send `"1"` (current code: integer string 1–10000) |
| Non-fungible classes | `metadata.fungible: false` |
| Status casing | token `state.status` lowercase (`active`, `frozen`, `burned`); enums inside loan `data` PascalCase |
| Results | async; poll `/v1/transaction/status`; no webhooks |
| Workflow api id | `api.workflow.execute` / `api.workflow.status` |
| Live programs | `fungible`, `non-fungible`, `credential`, `stables`, `purpose-bound-voucher` (blocked), `loan-nft-program`, `loan-pool-nft-program`, `hello-token` |

Quick consistency check:

```bash
grep -rn '"amount"\|Individual\|reference-ft\|nfh-voucher\|api.workflows\.' . | grep -vi "stale\|old\|older\|not \|never\|instead\|was\|renamed"
```

Review every hit. Most legitimate ones are "don't do this" notes.

## Style conventions

- Full JSON request bodies with a real `context.id` (`api.<group>.<action>`), not fragments.
- Placeholders in angle brackets: `<DEVELOPER_TOKEN>`, `<user JWT>`, `<tokenId>`. Never real secrets.
- Mark status inline: **live-verified**, **in code**, **environment-dependent**, **design**, **blocked**.
- Link across files with relative links (`[token-programs.md](token-programs.md)`) and cite source paths (`units-api/src/services/token.go`) for engineers.
