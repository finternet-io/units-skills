<p align="center">
  <a href="https://nfh.global">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/brand/nfh-logo-white.svg">
      <img src="assets/brand/nfh-logo-black.svg" alt="Networks for Humanity (NFH)" height="56">
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://finternetlab.io">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/brand/finternet-logo-white.png">
      <img src="assets/brand/finternet-logo-black.png" alt="Finternet" height="56">
    </picture>
  </a>
</p>

<h1 align="center">UNITS skills</h1>

<p align="center">
  <b>A Claude skill for building on UNITS, the ledger of <a href="https://finternetlab.io">Finternet</a>, a mission of <a href="https://nfh.global">Networks for Humanity (NFH)</a>.</b>
</p>

<p align="center">

[![CI](https://github.com/finternet-io/units-skills/actions/workflows/ci.yml/badge.svg)](https://github.com/finternet-io/units-skills/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Contributions welcome](https://img.shields.io/badge/contributions-welcome-brightgreen.svg)](CONTRIBUTING.md)

</p>

A Claude skill that knows **UNITS**, the federated ledger and tokenisation platform of **Finternet**, a mission of **Networks for Humanity (NFH)**. Load it into Claude Code, Claude.ai or the Claude API. Claude can then:

- answer integration questions from external partners (fintechs, lenders, registries, voucher platforms)
- design token classes and choose token programs for a use case
- write working client code (TypeScript, Python, curl)
- explain any error code and debug failed transactions
- help Finternet engineers work on the UNITS codebase: new token programs, hooks, workflows, local development

| | |
|---|---|
| **Scope** | Everything about UNITS **except deployment and infrastructure** (helm, terraform, cluster operations) |
| **Knowledge snapshot** | 2026-10-03 |
| **Skill name** | `units` |
| **Plugin / marketplace** | `units` @ `finternet-units` (version 1.0.0) |
| **Size** | `SKILL.md` (~95 lines) + 15 reference files (~10k lines) + runnable examples |

---

## Contents

1. [Who this is for](#1-who-this-is-for)
2. [What Claude can do with it](#2-what-claude-can-do-with-it)
3. [Install](#3-install)
4. [Repository layout](#4-repository-layout)
5. [How the skill works](#5-how-the-skill-works)
6. [Where the knowledge came from](#6-where-the-knowledge-came-from)
7. [Accuracy model: how conflicts were resolved](#7-accuracy-model-how-conflicts-were-resolved)
8. [How it was verified](#8-how-it-was-verified)
9. [Testing the skill yourself](#9-testing-the-skill-yourself)
10. [Maintaining and updating](#10-maintaining-and-updating)
11. [Packaging and versioning](#11-packaging-and-versioning)
12. [Security](#12-security)
13. [Known limitations of the skill](#13-known-limitations-of-the-skill)
14. [FAQ about this repo](#14-faq-about-this-repo)
15. [Contributing](#15-contributing)
16. [Community, support and security](#16-community-support-and-security)
17. [License](#17-license)

---

## 1. Who this is for

| Audience | Typical questions | Where Claude will look |
|---|---|---|
| **External integrators** (partners building on UNITS) | "Which portal do I use?", "How do we get API access?", "How do we represent our loans?", "Why did my mint fail?" | `portals-and-access.md`, `integration-playbook.md`, `auth-and-onboarding.md`, `token-classes.md`, `worked-examples.md`, `troubleshooting.md` |
| **Solution / product people** at Finternet or partners | "Can UNITS do X?", "How would we model warehouse receipts?" | `concepts.md`, `known-gaps.md`, `worked-examples.md` |
| **Finternet engineers** | "How do I add a token program?", "How does the transfer saga compensate?", "How do I run the stack locally?" | `authoring-token-programs.md`, `workflows-and-services.md`, `architecture.md`, `local-development.md` |

## 2. What Claude can do with it

- **Explain the model:** token class vs token class config vs token program vs token, and the three planes, federation, home instances and the registry.
- **Onboard a partner end to end:**
  - developer tokens and scopes
  - OTP login and signup
  - identity hashing
  - the operator-account pattern
  - signing `/v1/token/transact`
- **Design token classes** for loyalty points, KYC credentials, loans, loan pools, unique assets, stablecoin proxies and vouchers. Claude gives complete `register` and `config` requests and says honestly what works live today.
- **Produce exact API calls:** full JSON request bodies with the correct `context.id`, expected responses, the polling loop and tokenId lookup.
- **Debug:** map any sync or async error code to its cause and fix, and walk a stuck transaction from the API through to SQL, Restate and the Kafka DLQ.
- **Engineer:** write a new Rust `TokenProgram`, add a hook or config key, add a Restate workflow, run and debug the local stack.
- **Correct stale information:** older docs say things like header auth, `/v1/api-clients`, `reference-ft`, `entityType: "Individual"` and `amount` in transact. Claude knows the current truth (`troubleshooting.md` §E).

## 3. Install

### 3.1 Claude Code as a plugin (recommended for teams)

```bash
# Inside Claude Code; works with a local path or a git URL to this repo
/plugin marketplace add /path/to/units-skills
/plugin install units@finternet-units
```

The plugin manifest is in `.claude-plugin/`; see [`.claude-plugin/README.md`](.claude-plugin/README.md). Skills under `skills/` are discovered automatically.

### 3.2 Claude Code as a personal or project skill

```bash
# Personal: available in every project
cp -R skills/units ~/.claude/skills/units

# Project: committed alongside a codebase
mkdir -p .claude/skills && cp -R skills/units .claude/skills/units
```

To uninstall a personal copy, run `rm -rf ~/.claude/skills/units`.

### 3.3 Claude.ai (web / desktop): the path for external integrators

```bash
./scripts/package.sh            # builds dist/units-skill.zip
```

1. Open Claude.ai and go to **Settings → Capabilities**.
2. Make sure **Code execution and file creation** is enabled. Skills need it.
3. Under **Skills**, choose **Upload skill** and select `dist/units-skill.zip`.
4. Ask a question in any chat, for example: *"How do I register a loyalty-points token class on UNITS and mint 1,000 points?"*

On Team or Enterprise plans an admin can make the skill available to the whole organisation.

### 3.4 Claude API

Upload `dist/units-skill.zip` through the Skills API and reference the skill in your Messages API requests. The code-execution tool is required. See Anthropic's Agent Skills documentation for the current endpoint and beta header.

### 3.5 Check that it loaded

Ask: *"What's the difference between a token class and a token program on UNITS?"* A correct answer:
- names `tokenclass/register` and `tokenclassconfig/register`
- says the config is required, or every operation fails with `primitive_capability_missing`
- lists programs such as `fungible`, `credential` and `loan-nft-program`

## 4. Repository layout

```
units-skills/
├── README.md                     ← you are here
├── LICENSE                       MIT
├── CONTRIBUTING.md               how to report corrections and send PRs
├── CODE_OF_CONDUCT.md            Contributor Covenant (Finternet community)
├── SECURITY.md                   private vulnerability reporting
├── SUPPORT.md                    where to get help (repo vs Finternet)
├── CHANGELOG.md                  Keep a Changelog, semver
├── .editorconfig                 editor settings
├── assets/brand/                 official NFH + Finternet logos (not MIT-licensed) + usage notes
├── .gitignore                    dist/, caches, .env*
├── .github/
│   ├── workflows/ci.yml          lint + package on PRs; attaches the zip to tagged releases
│   ├── ISSUE_TEMPLATE/           content correction, skill answer problem, content request
│   └── PULL_REQUEST_TEMPLATE.md  PR checklist
├── .claude-plugin/
│   ├── README.md                 what the manifests do
│   ├── plugin.json               plugin manifest (name "units", version, license)
│   └── marketplace.json          marketplace "finternet-units" listing the plugin
├── scripts/
│   ├── README.md                 how packaging and linting work
│   ├── package.sh                builds dist/units-skill.zip
│   └── lint.sh                   validates JSON, frontmatter, examples, links, secrets (CI)
├── dist/                         build output (git-ignored)
└── skills/
    ├── README.md                 how skills are organised in this repo
    └── units/                    ← THE SKILL (this folder is what gets zipped)
        ├── SKILL.md              entry point: mental model, 10 golden rules, environments, router
        ├── README.md             human guide to the skill folder
        ├── references/           15 deep reference files (+ README index)
        │   ├── portals-and-access.md        web portals per env, sign-up, API Access → developer tokens, scopes
        │   ├── concepts.md                  what UNITS is, data model, ~245-term glossary
        │   ├── architecture.md              components, flows, federation, environments, repo map
        │   ├── auth-and-onboarding.md       developer tokens, OTP, JWTs, signing, scopes, delegations
        │   ├── api-reference.md             every endpoint, envelopes, status vocabularies, error codes
        │   ├── token-classes.md             classes, configs, hooks, design guide, 7 worked classes, seeds
        │   ├── token-programs.md            every program and operation with payloads and errors
        │   ├── integration-playbook.md      step-by-step external integration + go-live checklist
        │   ├── worked-examples.md           7 end-to-end scenarios (loans, KYC, points, stablecoins…)
        │   ├── authoring-token-programs.md  build a new Rust token program / hook (engineers)
        │   ├── workflows-and-services.md    Restate sagas, registry, proofs, OTP, adapters
        │   ├── local-development.md         run, test and debug the stack locally
        │   ├── troubleshooting.md           symptom → cause → fix; docs-vs-reality table
        │   ├── known-gaps.md                current limitations, workarounds, honest claims
        │   └── faq.md                       74 quick answers with links
        └── examples/             runnable code (+ README)
            ├── units-client.ts              Node 20+ client, zero dependencies
            ├── units_client.py              Python 3.10+ client (requests + cryptography)
            ├── quickstart.sh                curl + jq first round trip
            └── token-classes/               7 ready-made register+config payloads (+ README)
```

Every folder has its own `README.md` with more detail.

## 5. How the skill works

Skills load progressively, so the context window stays small:

1. **Always loaded:** only the `name` and `description` from `SKILL.md`'s frontmatter. The description lists the trigger topics (UNITS, Finternet, token classes, programs, mint, transact, …).
2. **Loaded when triggered:** the body of `SKILL.md` (about 95 lines). It contains:
   - the five-line mental model
   - the **10 rules that prevent most integration failures**
   - the environments table
   - a short "choosing a program" table
   - a **router** telling Claude which reference to open for each kind of question
3. **Loaded on demand:** individual files in `references/` and `examples/`. Claude reads them before answering field-level questions instead of answering from memory. `SKILL.md` explicitly tells it to.

The design rule is that **`SKILL.md` stays short; detail lives in `references/`**. If you add knowledge, put it in the right reference file and only touch `SKILL.md` when a top-level rule or route changes.

## 6. Where the knowledge came from

The skill was compiled in October 2026 from:

| Source | What it contributed |
|---|---|
| UNITS source code: API (Go), token engine and programs (Rust), workflows (TypeScript/Restate), supporting services | Routes, auth, JSON schemas, seeded token classes and programs, every program operation, engine pipeline, workflows |
| UNITS specifications (OpenAPI + JSON Schemas) | Endpoint contracts, token and account schemas |
| Public documentation, https://docs.finternetlab.io | Concepts, guides, use cases, changelog |
| The Finternet web portal | Sign-up, API Access and developer-token flows |
| Hands-on integration testing against the sandbox (Aug 2026) | Verified payloads, gotchas, error catalogue |

## 7. Accuracy model: how conflicts were resolved

The sources often disagree. Old docs, current code and live behaviour drift apart. The skill applies this precedence:

1. **Behaviour verified live** on the sanctum sandbox (Aug 2026)
2. **Current code** (units-api HEAD, token runtime)
3. **specs/** OpenAPI and JSON Schemas
4. **Public docs** (docs.finternetlab.io)
5. **Older design documents**

Where live behaviour and code differ, the skill states both and labels the point **environment-dependent**. Examples:

- **Signature on `/v1/token/transact`:** required in code, but not enforced on sanctum in Aug 2026.
- **Loan amount field:** current code uses `data.value`; older builds used `data.amount`.

The skill also labels every capability as **live-verified**, **in code** or **design/roadmap**.

> ⚠️ **Build differences.** Environments can run different builds, so some behaviour differs between sandbox and production. The skill tells users to trust live behaviour and to verify with `/v1/tokenclassconfig/get` and `/v1/tokenprogram/search`.

## 8. How it was verified

- **Canonical facts sheet.** A single list of settled facts (envelope, credentials, identity hashing, program ids, async model, gaps) was written first. Every reference file was written against it.
- **Code spot-checks** settled the conflicts:
  - `identities: []` on class register stamps the caller as owner and issuer
  - `foir` takes an integer string from 1 to 10000
  - `valueFormat` is only accepted on token get, search, mint and transact
  - `entityType` is `PERSONAL` or `BUSINESS`
  - the engine treats a class as fungible unless `metadata.fungible: false`
  - api id is `api.workflow.execute`
  - the tokenId lookup order
- **Consistency audit.** An independent reviewer read every file and fixed contradictions: api ids, loan payloads, operation counts, status casing and error codes.
- **Blind test.** A fresh agent with only the skill answered 10 realistic integrator questions. The gaps it found were fixed: loyalty min-balance/lock behaviour, credential trust and revocation, gold-loan collateral, tokenId lookup, scope for `update`.
- **Code checks:**
  - `tsc --strict` and `node --check` on the TS client
  - `py_compile` on the Python client
  - `bash -n` on the quickstart
  - JSON parse of all class files
  - offline self-tests (`node units-client.ts selftest`)
- **Not done:** no calls were made against a live instance during this build. The Rust `warranty-nft` example in `authoring-token-programs.md` was not compiled, because there was no cargo toolchain.

## 9. Testing the skill yourself

### Smoke prompts (with expected key points)

| Prompt | A good answer mentions |
|---|---|
| "How do we get API access to UNITS?" | self-serve on the portal (`sanctum.finternetlab.io` → API Access → Register client; token shown once), scopes to pick, API base `units.sanctum.finternetlab.io`, operator account; email engineering@finternetlab.io as fallback |
| "Set up a loan token class and originate a loan." | `tokenclass/register` (`UNITS-Loan`, `metadata.fungible:false`) + `tokenclassconfig/register` (`loan-nft-program`), mint with a full `LoanOriginatedPayload`, **no `identities`**, poll status |
| "We minted but have no tokenId." | poll `/v1/transaction/status`, then tokenId from `transaction/get` (`metadata.token_id` → `affectedTokenIds[0]` → `responseData`), fallback `token/search` |
| "401 signature with keyId and jws is required." | register an Ed25519 key, raw Ed25519 over the JCS of `payload`, std base64 |
| "FORBIDDEN no_matching_allow_rule after mint." | `identities[]` sent on mint; operator/ownership rules |
| "Is UNITS a blockchain?" | No: Postgres ledger with hash-chained state commitments; Merkle batching partial; anchoring is roadmap |

### Example code

```bash
cd skills/units/examples
node units-client.ts selftest            # offline: JCS + Ed25519 + hashing
python3 units_client.py selftest         # needs: pip install requests cryptography
bash -n quickstart.sh                    # syntax only; running it hits a live instance
```

## 10. Maintaining and updating

UNITS changes fast. Refresh the skill when any of these happen:
- a program is added or changed
- an endpoint is added or renamed
- a known gap is fixed
- a new environment is added
- auth or onboarding changes

**Update workflow:**

1. Pull the latest source repos (`units-api`, `units-token-runtime`, `units-workflows`, `units-services`, `specs`, `docs.finternetlab.io`).
2. Find what changed: CHANGELOGs, `git log`, new seeds in `units-api/scripts/seed/`, the `registry/src/registry.rs` program list.
3. Edit the **owning reference file**:

   | Change | File(s) |
   |---|---|
   | New or changed endpoint, error code | `api-reference.md`, `troubleshooting.md` |
   | Auth, scopes, onboarding | `auth-and-onboarding.md`, `integration-playbook.md` |
   | New program or operation, payload change | `token-programs.md`, `token-classes.md` (decision table), `examples/token-classes/` |
   | Gap fixed or found | `known-gaps.md`, plus remove workarounds elsewhere |
   | Engine, workflow or service internals | `authoring-token-programs.md`, `workflows-and-services.md`, `architecture.md` |
   | Local tooling | `local-development.md` |

4. If a **golden rule**, environment, or program status changed, update `skills/units/SKILL.md` (the rules list and the "Choosing a program" table).
5. Update the **snapshot date** in `SKILL.md`, this README and `references/README.md`.
6. Run a consistency grep for the facts you changed, for example:
   ```bash
   grep -rn "amount\|foir\|valueFormat\|identities: \[\]" skills/units
   ```
7. Re-run the smoke prompts from §9 and the example self-tests.
8. Bump `version` in `.claude-plugin/plugin.json` and re-package (§11).

## 11. Packaging and versioning

- `./scripts/package.sh` → `dist/units-skill.zip`. The zip root is the `units/` folder, which is the format Claude.ai and the Skills API expect. Details are in [`scripts/README.md`](scripts/README.md).
- Versioning uses semver in `.claude-plugin/plugin.json`:
  - **patch** for corrections
  - **minor** for new references or examples, or platform capabilities documented
  - **major** if the skill's structure or name changes
- After bumping, re-upload the zip on Claude.ai (replace the existing skill) and run `/plugin marketplace update finternet-units` in Claude Code.

## 12. Security

- **No secrets are in this repo.** Payloads use placeholders such as `<DEVELOPER_TOKEN>` and `Bearer <user JWT>`.
- Local-dev fixture credentials in `units-api/manifests/...` are referred to by path only, never pasted.
- The skill tells Claude to never ask users for secrets or echo them, and to keep developer tokens server-side.
- `.gitignore` excludes `.env*` and `dist/`.
- Before publishing a new version, run a secrets scan:
  ```bash
  grep -rnE "c2Et[A-Za-z0-9+/=]{20,}|eyJ[A-Za-z0-9_-]{30,}|BEGIN .*PRIVATE" skills/
  ```
  It should print nothing.
- The sandbox OTP `123456` is a documented non-production convenience, not a secret.

## 13. Known limitations of the skill

- **Point-in-time knowledge** (2026-10-03). Claude is told to recommend verifying against the live instance, but it can still be out of date.
- **Unconfirmed live behaviour** is labelled in the files. It includes:
  - the tokenId lookup order on deployed builds
  - non-fungible and loan-pool programs on sanctum
  - local compose ports
  - whether older builds accept `foir: "1"`
- **Business, commercial and regulatory onboarding** (contracts, KYC of the partner itself, pricing) isn't covered. Claude will refer users to Finternet.
- **Deployment** (helm, terraform, clusters, CI/CD) is deliberately excluded.

## 14. FAQ about this repo

**Can I share the zip with external partners?**
Yes. It's written for them, contains no secrets, and is honest about functional limitations.

**Why one big skill instead of several small ones?**
One trigger surface ("anything UNITS") with a router is more reliable than several overlapping descriptions. Progressive loading keeps it cheap: only `SKILL.md` and the files a question needs are read.

**Can I add a second skill (e.g. `units-deploy`)?**
Yes. Create `skills/units-deploy/SKILL.md`; the plugin picks it up automatically. See [`skills/README.md`](skills/README.md).

**How do I check my changes before opening a PR?**
Run `./scripts/lint.sh`. CI runs the same script on every pull request.

---

## 15. Contributing

Contributions are welcome. The most valuable are **corrections from real integrations**: a field that changed, an error message with a different cause, or a flow that now works. Start with [CONTRIBUTING.md](CONTRIBUTING.md), which covers:
- how to report outdated content (with evidence, and **without secrets**)
- where each kind of fact lives
- content and code guidelines
- the PR checklist and commit conventions

Quick start:

```bash
git clone <this repo> && cd units-skills
# edit skills/units/…
./scripts/lint.sh
```

Issue templates are provided for **content corrections**, **skill answer problems** (Claude answered badly while using the skill) and **content requests**.

## 16. Community, support and security

- **Questions about this repo:** open an issue.
- **Questions about UNITS:** the [public docs](https://docs.finternetlab.io) and the Finternet Discord (https://discord.com/invite/x44vzPHmJ2).
- **Account, API access, platform bugs:** the portal's API Access page, or engineering@finternetlab.io. See [SUPPORT.md](SUPPORT.md).
- **Security vulnerabilities:** report privately. See [SECURITY.md](SECURITY.md).
- **Conduct:** everyone participating follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## 17. License

[MIT](LICENSE) © 2026 Networks for Humanity (NFH) and contributors. You may use, copy, modify and redistribute the skill, references and example code, including commercially, as long as you keep the copyright notice.

"Networks for Humanity", "NFH", "Finternet" and "UNITS" and their logos are trademarks or brand assets of Networks for Humanity and are **not** covered by the MIT license. The logos in [`assets/brand/`](assets/brand/) are included only to identify the project; see [`assets/brand/README.md`](assets/brand/README.md) for usage. The license also doesn't grant access to UNITS services; access is governed by Finternet's own terms.
