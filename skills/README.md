# `skills/`: skill packages

Each subfolder here is one **Claude skill**: a folder with a `SKILL.md` (YAML frontmatter + instructions) plus any supporting files Claude can read on demand.

| Skill | Folder | Purpose |
|---|---|---|
| `units` | [`units/`](units/) | Everything about UNITS (the ledger/token platform of Finternet, a mission of Networks for Humanity) except deployment: concepts, integration, auth, API, token classes and programs, worked examples, program authoring, workflows, local development, troubleshooting |

## Anatomy of a skill

```
<skill-name>/
├── SKILL.md          required. Frontmatter (name, description) + concise instructions and a router
├── README.md         for humans browsing the repo. Not needed by Claude
├── references/       deep documentation Claude opens only when a question needs it
└── examples/         runnable code and payloads Claude can quote or adapt
```

### `SKILL.md` frontmatter rules

```yaml
---
name: units                     # lowercase, hyphens; must match the folder name
description: Expert knowledge of UNITS … Use whenever someone asks about …   # ≤ ~1024 chars
---
```

- The **`description` is the trigger.** It's the only part always in Claude's context. It must name the product, the main concepts and the kinds of questions, and say what the skill is *not* for (here: deployment).
- The body should stay short, ideally under 500 lines; `units` is about 95. Put detail in `references/` and **tell Claude which file to read for which question**.

## Adding a new skill

1. Create `skills/<new-name>/SKILL.md` with frontmatter and a short body.
2. Add references and examples as needed, plus a `README.md` in each folder.
3. Add it to the table above.
4. Claude Code picks it up automatically through the plugin. For Claude.ai, add a packaging line to `scripts/package.sh`, e.g. `zip -qr ../dist/<new-name>-skill.zip <new-name>`.

Keep skills separate only when their triggers don't overlap. Anything about UNITS belongs in `units`, so new UNITS knowledge should go into `units/references/` instead of a new skill. The exception is a deployment/infrastructure skill, which this one deliberately excludes.
