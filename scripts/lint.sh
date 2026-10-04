#!/usr/bin/env bash
# Validates the repository: manifests, skill frontmatter, example code, JSON payloads,
# relative Markdown links, and a secrets scan. Used locally and by CI.
#   ./scripts/lint.sh            # all checks
#   SKIP_SELFTEST=1 ./scripts/lint.sh   # skip running the example clients' offline self-tests
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=1; }
skip() { printf '  \033[33mskip\033[0m %s\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

echo "1. JSON files"
while IFS= read -r f; do
  if python3 -m json.tool "$f" >/dev/null 2>&1; then ok "$f"; else bad "$f is not valid JSON"; fi
done < <(find .claude-plugin skills -name '*.json' -not -path '*/node_modules/*' | sort)

echo "2. Skill frontmatter"
for skill in skills/*/; do
  name="$(basename "$skill")"
  md="$skill/SKILL.md"
  [ -f "$md" ] || { bad "$md missing"; continue; }
  python3 - "$md" "$name" <<'PY' && ok "$md (name + description)" || bad "$md frontmatter invalid"
import re, sys
text = open(sys.argv[1], encoding="utf-8").read()
m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
assert m, "no frontmatter"
fm = m.group(1)
name = re.search(r"^name:\s*(.+)$", fm, re.M)
desc = re.search(r"^description:\s*(.+)$", fm, re.M)
assert name and name.group(1).strip() == sys.argv[2], "name must match folder"
assert re.fullmatch(r"[a-z0-9-]{1,64}", name.group(1).strip()), "name must be lowercase/hyphens"
assert desc and 0 < len(desc.group(1).strip()) <= 1024, f"description length {len(desc.group(1).strip()) if desc else 0} (max 1024)"
PY
done

echo "3. Shell scripts"
while IFS= read -r f; do
  if bash -n "$f"; then ok "$f"; else bad "$f syntax"; fi
done < <(find scripts skills -name '*.sh' | sort)

echo "4. Python examples"
while IFS= read -r f; do
  if python3 -m py_compile "$f" 2>/dev/null; then ok "$f compiles"; else bad "$f does not compile"; fi
done < <(find skills -name '*.py' | sort)
find skills -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null

echo "5. Example self-tests (offline, no network)"
if [ "${SKIP_SELFTEST:-0}" = "1" ]; then
  skip "SKIP_SELFTEST=1"
else
  ts=skills/units/examples/units-client.ts
  if have node; then
    if (cd "$(dirname "$ts")" && node --experimental-strip-types "$(basename "$ts")" selftest >/dev/null 2>&1 \
        || node "$(basename "$ts")" selftest >/dev/null 2>&1); then ok "$ts selftest"; else bad "$ts selftest (needs Node >= 22.6)"; fi
  else skip "node not installed"; fi
  py=skills/units/examples/units_client.py
  if python3 -c "import requests, cryptography" 2>/dev/null; then
    if (cd "$(dirname "$py")" && python3 "$(basename "$py")" selftest >/dev/null 2>&1); then ok "$py selftest"; else bad "$py selftest"; fi
  else skip "$py selftest (pip install requests cryptography)"; fi
  find skills -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null
fi

echo "6. Relative Markdown links"
python3 - <<'PY' && ok "all relative links resolve" || fail=1
import os, re, sys
bad = []
for root, _, files in os.walk("."):
    if any(p in root for p in ("/.git", "/dist", "/node_modules")):
        continue
    for fn in files:
        if not fn.endswith(".md"):
            continue
        path = os.path.join(root, fn)
        text = open(path, encoding="utf-8").read()
        text = re.sub(r"```.*?```", "", text, flags=re.S)  # ignore code blocks
        for target in re.findall(r"\]\(([^)\s]+)\)", text):
            if re.match(r"^(https?:|mailto:|#)", target):
                continue
            # GitHub-relative repo pages (issues, security advisories, pulls) only exist on GitHub
            if re.match(r"^(\.\./)+(issues|security|pulls|discussions|releases|actions)(/|$)", target):
                continue
            target = target.split("#", 1)[0]
            if target and not os.path.exists(os.path.normpath(os.path.join(root, target))):
                bad.append(f"{path} -> {target}")
for b in bad:
    print(f"  \033[31mFAIL\033[0m broken link {b}")
sys.exit(1 if bad else 0)
PY

echo "7. Secrets scan"
pattern='c2Et[A-Za-z0-9+/=]{20,}|eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}'
if grep -rnE "$pattern" --exclude-dir=.git --exclude-dir=dist --exclude=lint.sh . ; then
  bad "possible secret found (see above)"
else
  ok "no secrets matched"
fi

echo
if [ "$fail" -ne 0 ]; then echo "lint: FAILED"; exit 1; fi
echo "lint: all checks passed"
