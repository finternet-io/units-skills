#!/usr/bin/env bash
# Builds dist/units-skill.zip for upload to Claude.ai (Settings → Capabilities → Skills)
# or the Claude API Skills endpoint. The zip root contains the `units/` skill folder.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf dist && mkdir -p dist
(cd skills && zip -qr ../dist/units-skill.zip units -x '*.DS_Store')
echo "Built dist/units-skill.zip ($(du -h dist/units-skill.zip | cut -f1))"
