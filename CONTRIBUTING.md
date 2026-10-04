# Contributing to UNITS skills

Thanks for helping make Claude better at UNITS. Corrections from people who actually integrate with UNITS are the most valuable contributions this project gets: a wrong field name or an outdated error message costs every future reader time.

## Table of contents

- [Code of Conduct](#code-of-conduct)
- [Ways to contribute](#ways-to-contribute)
- [I have a question](#i-have-a-question)
- [Reporting incorrect or outdated content](#reporting-incorrect-or-outdated-content)
- [Suggesting new content](#suggesting-new-content)
- [Making a change](#making-a-change)
- [Content guidelines](#content-guidelines)
- [Code guidelines (examples)](#code-guidelines-examples)
- [Pull request checklist](#pull-request-checklist)
- [Commit messages](#commit-messages)
- [Releases](#releases)
- [Legal](#legal)

## Code of Conduct

Everyone taking part is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). Report unacceptable behaviour privately to **engineering@finternetlab.io**.

## Ways to contribute

| Contribution | How |
|---|---|
| Fix a wrong fact: endpoint, field name, error code, status, behaviour | Open a **Content correction** issue, or send a PR directly |
| Add a missing topic, example or use case | Open a **Content request** issue first if it's large |
| Improve the example clients (`units-client.ts`, `units_client.py`, `quickstart.sh`) | PR with the self-tests passing |
| Report that Claude gave a bad answer *while using the skill* | Open a **Skill answer problem** issue with the prompt and answer |
| Translate, restructure or clarify | PR; keep `SKILL.md` short |

Questions about **UNITS itself** (your account, credentials, platform bugs) belong with Finternet, not here. See [SUPPORT.md](SUPPORT.md).

## I have a question

1. Search existing [issues](../../issues) and the [public docs](https://docs.finternetlab.io).
2. Ask in the Finternet Discord (https://discord.com/invite/x44vzPHmJ2).
3. If it's about this repo's content, open an issue with as much context as you can.

## Reporting incorrect or outdated content

UNITS changes quickly, so this skill is a **snapshot** (see the date in [`skills/units/SKILL.md`](skills/units/SKILL.md)). When you find a mismatch, include:

- **File and section**, e.g. `references/token-programs.md` §9 `loan_disbursed`
- **What the skill says** vs **what you observed**
- **Evidence**: the request and response (with **all tokens and JWTs removed**), the environment (`sanctum` / production / local), the date, and the build if known. Source links (repo + path + commit) are even better.
- Whether it's **live behaviour** or **code reading**. Live observations take precedence over code, which takes precedence over docs.

> ⚠️ **Never paste developer tokens, client secrets, JWTs, OTPs or personal data** into issues or PRs. A developer token starts with `c2Et`; a JWT starts with `eyJ`. If you leak one, rotate it immediately in the portal (API Access → Rotate secret).

## Suggesting new content

Good candidates:
- a worked example for a use case not yet covered
- a new error and its fix
- a FAQ entry for a question you had to dig for
- a new or changed program operation

Open a **Content request** issue describing the audience (integrator or engineer), the question it answers, and the sources.

## Making a change

```bash
git clone <this repo> && cd units-skills
# edit files…
./scripts/lint.sh                 # must pass
./scripts/package.sh              # optional: build dist/units-skill.zip to test on Claude.ai
```

To test the skill in Claude Code while editing:

```bash
cp -R skills/units ~/.claude/skills/units     # or: /plugin marketplace add "$(pwd)"
```

Then ask the smoke prompts from [README §9](README.md#9-testing-the-skill-yourself) and confirm the answers use your change.

### Where things go

| Change | File |
|---|---|
| Portals, sign-up, developer tokens, scopes presets | `skills/units/references/portals-and-access.md` |
| Credentials, signing, delegations | `skills/units/references/auth-and-onboarding.md` |
| Endpoint request/response, error codes | `skills/units/references/api-reference.md`, `troubleshooting.md` |
| Token class/config fields, hooks, choosing a program | `skills/units/references/token-classes.md` |
| Program operations and payloads | `skills/units/references/token-programs.md` (+ `examples/token-classes/*.json`, both clients) |
| End-to-end scenarios | `skills/units/references/worked-examples.md` |
| Limitations | `skills/units/references/known-gaps.md` |
| Quick Q&A | `skills/units/references/faq.md` |
| Engine/workflow internals, local dev | `authoring-token-programs.md`, `workflows-and-services.md`, `local-development.md`, `architecture.md` |
| A golden rule, environment, program status or route | `skills/units/SKILL.md` (keep it short) |

The full ownership map is in [`skills/units/references/README.md`](skills/units/references/README.md).

## Content guidelines

1. **Accuracy over completeness.** If you aren't sure, say so and mark it.
2. **Label status** inline: **live-verified**, **in code**, **environment-dependent**, **design/roadmap**, **blocked**.
3. **Copy-pasteable JSON.** Use full request bodies with a real `context.id` (`api.<group>.<action>`), not fragments. Use placeholders in angle brackets: `<DEVELOPER_TOKEN>`, `Bearer <user JWT>`, `<tokenId>`.
4. **One owner per fact.** Change the fact in its owning file, then grep for other mentions and update or link them. The "facts every file agrees on" table in `references/README.md` lists the ones that are easy to break.
5. **Keep `SKILL.md` small** (under ~120 lines). Detail belongs in `references/`. The frontmatter `description` must stay ≤ 1024 characters (CI checks this).
6. **Be honest about the platform.** UNITS is a hash-chained ledger, not a blockchain. Don't claim anchoring, encryption or features that aren't live. See `known-gaps.md` §10.
7. **No secrets, no personal data, no private partner material.** Don't add internal hostnames, cluster names, customer names or confidential plans without Finternet's permission.
8. **Style:** plain English, short sentences, tables for comparisons, relative links between files, and a snapshot date when you add time-sensitive facts.

## Code guidelines (examples)

- `units-client.ts`: Node 20+ (self-test needs Node ≥ 22.6 for type stripping). **No runtime dependencies.** Strict TypeScript.
- `units_client.py`: Python 3.10+, only `requests` and `cryptography`.
- `quickstart.sh`: bash with `set -euo pipefail`. Needs only curl and jq. Never print tokens.
- Both clients must stay **behaviourally identical**: same envelope, the same JCS canonicalisation and Ed25519 signatures (the self-tests compare them), and the same tokenId lookup order.
- Never call a live API in tests. Self-tests are offline.

## Pull request checklist

- [ ] `./scripts/lint.sh` passes (CI runs it too)
- [ ] Facts are sourced (live observation, code path + commit, or doc link) in the PR description
- [ ] Status labels added where behaviour is environment-dependent or unverified
- [ ] Related files updated (grep for the fact you changed)
- [ ] `SKILL.md` touched only if a rule, route, environment or program status changed
- [ ] [CHANGELOG.md](CHANGELOG.md) entry under **Unreleased**
- [ ] No secrets, tokens, JWTs or personal data

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
docs(token-programs): loan_disbursed uses data.value on current builds
fix(examples): resolve tokenId from metadata.token_id first
feat(references): add warehouse-receipt worked example
chore(ci): check SKILL.md description length
```

Types: `docs` (content), `fix` (example code bugs), `feat` (new reference, example or capability), `chore`, `ci`, `refactor`.

## Releases

Maintainers cut releases:
1. Move **Unreleased** in `CHANGELOG.md` to a new version.
2. Bump `version` in `.claude-plugin/plugin.json` (semver: **patch** = corrections, **minor** = new content/examples, **major** = structure or skill name change).
3. Update the snapshot date in `SKILL.md` if the content was re-verified.
4. Tag `vX.Y.Z`. CI attaches `dist/units-skill.zip` to the GitHub release.

## Legal

By contributing, you agree that:
- you wrote the content or have the right to submit it;
- it contains no confidential information you aren't allowed to share;
- it's licensed under the project's [MIT License](LICENSE).
