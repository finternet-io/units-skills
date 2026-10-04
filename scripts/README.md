# `scripts/`: build tooling

## `package.sh`

Builds the upload artefact for **Claude.ai** and the **Claude API Skills endpoint**.

```bash
./scripts/package.sh
# → Built dist/units-skill.zip (≈360K)
```

### What it does

1. `cd`s to the repo root, so you can run it from anywhere.
2. Deletes and recreates `dist/`.
3. Zips `skills/units/` so that the **zip root contains the `units/` folder**:
   ```
   units-skill.zip
   └── units/
       ├── SKILL.md
       ├── README.md
       ├── references/…
       └── examples/…
   ```
   Claude.ai and the Skills API expect exactly this layout: one top-level folder whose name matches the skill and which contains `SKILL.md`.
4. Excludes `.DS_Store` files.

### Requirements

`bash` and `zip`. Both are preinstalled on macOS and on most Linux systems.

### Check the artefact

```bash
unzip -l dist/units-skill.zip | head          # first entries should be units/…
unzip -p dist/units-skill.zip units/SKILL.md | head -5   # frontmatter with name: units
```

### Before packaging a release

1. Remove stray caches with `find skills -name __pycache__ -exec rm -rf {} +`.
2. Run `./scripts/lint.sh` (includes the secrets scan).
3. Bump `version` in `.claude-plugin/plugin.json`.
4. Run `./scripts/package.sh`.
5. Upload `dist/units-skill.zip`. On Claude.ai, use Settings → Capabilities → Skills, then replace the existing `units` skill.

`dist/` is git-ignored, so build artefacts are never committed.

## `lint.sh`

Validates the repository. CI (`.github/workflows/ci.yml`) runs it on every push and pull request.

```bash
./scripts/lint.sh                  # all checks
SKIP_SELFTEST=1 ./scripts/lint.sh  # skip running the example self-tests
```

| # | Check | Fails when |
|---|---|---|
| 1 | All `*.json` in `.claude-plugin/` and `skills/` parse | Invalid JSON |
| 2 | Every `skills/*/SKILL.md` has frontmatter | `name` ≠ folder name or not lowercase/hyphens; `description` missing or **> 1024 characters** (Claude.ai limit) |
| 3 | `bash -n` on every `*.sh` | Syntax error |
| 4 | `py_compile` on every `*.py` | Syntax error |
| 5 | Offline self-tests of `units-client.ts` (Node ≥ 22.6) and `units_client.py` (needs `requests`, `cryptography`) | Hashing, JCS or Ed25519 signing broken. Skipped if the runtime or deps are missing. |
| 6 | Relative Markdown links resolve (code blocks and GitHub-only `../../issues` links ignored) | A link points to a missing file |
| 7 | Secrets scan: developer tokens (`c2Et…`), JWTs, private keys, AWS keys, GitHub tokens | A match is found |

## CI and releases

`.github/workflows/ci.yml`:
- **on push and pull request:** sets up Node 22 and Python 3.12, installs the Python example deps, runs `lint.sh`, runs `package.sh`, and uploads `units-skill.zip` as a build artifact.
- **on a `v*` tag:** additionally creates a GitHub Release with `dist/units-skill.zip` attached and auto-generated notes.

## Adding scripts

Keep scripts POSIX-friendly bash with `set -euo pipefail`, and document each one in this README. Wire any new check into `lint.sh`, so CI picks it up automatically.
