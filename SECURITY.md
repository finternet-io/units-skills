# Security policy

This repository contains documentation and example client code for **UNITS**, the ledger/tokenisation platform of Finternet (a mission of Networks for Humanity). It contains no services and no secrets.

## Reporting a vulnerability

| What you found | Where to report |
|---|---|
| A vulnerability **in UNITS or Finternet services** (API, portal, registry, auth) | **engineering@finternetlab.io**, subject "Security". Acknowledged within two business days. **Do not** open a public issue. |
| A vulnerability **in this repo's example code** (e.g. the clients leak tokens in logs, unsafe signing) | Same email, or a private [GitHub security advisory](../../security/advisories/new) on this repo |
| A **leaked credential** in this repo or its history | Email immediately. If it's yours, also rotate it in the portal (**API Access → Rotate secret**) or deactivate the client. |

Please include:
- affected component and version or commit
- reproduction steps
- impact
- any proof of concept

Remove real tokens and personal data from the report.

We ask that you:
- give us reasonable time to fix the issue before public disclosure;
- don't access data that isn't yours, and don't degrade the service;
- test only against your own accounts on the **sandbox** (`sanctum`) environment.

## Supported versions

Only the latest release of this repository is maintained. The skill describes UNITS as of the snapshot date in `skills/units/SKILL.md`.

## Using the examples safely

- The **developer token** is a server-side credential. Never embed it in browser or mobile apps, commit it, or paste it into chats, issues or AI prompts.
- Keep user JWTs and refresh tokens server-side. Refresh tokens are single-use; reuse revokes the session.
- Store Ed25519 signing keys in a secret manager or HSM. The examples generate keys in memory for demonstration only.
- Use separate API clients per environment and service, with least-privilege scopes. Rotate on a schedule.
- The sandbox OTP `123456` must never be relied on outside sandbox environments.
