# `.claude-plugin/`: plugin and marketplace manifests

This folder makes the repository installable as a **Claude Code plugin**. A plugin bundles one or more skills (and could also bundle commands, agents or hooks). A **marketplace** is a catalogue that lists plugins. This repo is both: one marketplace that contains one plugin.

## Files

### `plugin.json`: the plugin manifest

```json
{
  "name": "units",
  "version": "1.0.0",
  "description": "UNITS (Finternet ledger) knowledge skill: …",
  "author": { "name": "Networks for Humanity (NFH) · Finternet" },
  "keywords": ["finternet", "units", "tokenisation", "ledger", "token-programs"]
}
```

| Field | Meaning |
|---|---|
| `name` | Plugin id. Users install it as `units@<marketplace>`. |
| `version` | Semver. Bump it on every published change (see the root README §11). |
| `description` | Shown in `/plugin` listings. |
| `author`, `keywords` | Metadata for discovery. |

Components are discovered by convention from the plugin root. Every `skills/<name>/SKILL.md` becomes a skill. Today that's only `skills/units/`.

### `marketplace.json`: the marketplace catalogue

```json
{
  "name": "finternet-units",
  "owner": { "name": "Networks for Humanity (NFH)" },
  "plugins": [
    { "name": "units", "source": "./", "description": "Everything you need to integrate with and build on UNITS (except deployment)." }
  ]
}
```

| Field | Meaning |
|---|---|
| `name` | Marketplace id, used after the `@` in `/plugin install units@finternet-units`. |
| `owner` | Who maintains the marketplace. |
| `plugins[].source` | Where the plugin lives relative to the marketplace root. `./` means this same repo. |

## Install and update commands (inside Claude Code)

```bash
/plugin marketplace add /path/to/units-skills          # or a git URL, e.g. github.com/<org>/units-skills
/plugin install units@finternet-units
/plugin marketplace update finternet-units             # pull a newer version
/plugin uninstall units@finternet-units
```

## Adding more plugins later

To publish a second, separate plugin from the same marketplace:
1. Put it in a subfolder, e.g. `plugins/units-deploy/`, with its own `.claude-plugin/plugin.json` and `skills/`.
2. Add an entry to `marketplace.json`: `{ "name": "units-deploy", "source": "./plugins/units-deploy", "description": "…" }`.

To add another **skill to this plugin** instead, just create `skills/<new-skill>/SKILL.md`. No manifest change is needed.

## Validation

Both files must be valid JSON:

```bash
python3 -m json.tool .claude-plugin/plugin.json >/dev/null && python3 -m json.tool .claude-plugin/marketplace.json >/dev/null && echo OK
```
