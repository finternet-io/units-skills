# Portals and access: the Finternet web app, environments, and getting API credentials

This file covers everything a person needs **before** writing code:
- which website to use
- how to create an account there
- what the portal can do
- how to get a **developer token** (API credentials) and the right scopes
- how to manage those credentials
- how to get help

Snapshot 2026-10-03. Sources:
- the Finternet web app
- public environment hostnames (deployment is out of scope)
- the public docs `docs.finternetlab.io`
- units-api and the registry

> **Key correction to older guidance:** a developer token **can** be self-served. The web portal's **API Access** page registers an API client for you. The portal's backend makes the registration call with its own platform-level service account, which is the only reason the "superadmin required" rule on `POST /v1/clients/register` doesn't block you there. Calling `/v1/clients/register` directly with your own token still returns `403 … requires a superadmin service account (interim governance)`.

---

## 1. The surfaces at a glance

| What | Sanctum (staging; **the integrator sandbox**) | Production | Foundry (dev; internal) |
|---|---|---|---|
| **Web portal** (Finternet app) | https://sanctum.finternetlab.io | https://my.finternetlab.io | https://foundry.finternetlab.io |
| **UNITS API base** | `https://units.sanctum.finternetlab.io` | `https://units.finternetlab.io` | `https://units.foundry.finternetlab.io` |
| **Registry** (federation directory; you rarely call it) | `registry.sanctum.finternetlab.io` | `registry.finternetlab.io` | internal only |
| Portal login methods | Email/phone **OTP** + Google SSO | **Google SSO only** (the email/phone OTP form is disabled) | Email/phone OTP + Google SSO |
| OTP for testing | Fixed `123456` accepted (a real email or SMS may still be sent) | Real OTP | Fixed `123456` |
| Availability | Available ~**08:00–21:00 IST, Mon–Fri**. Expect it down nights and weekends. | Always on | Not a supported integration target; may be unavailable |
| Build | Newest | May run an older build than Sanctum; re-test environment-dependent behaviour | Varies |
| Data | Test data; may be reset | Real | Throwaway |

Other public resources:

| Resource | URL / contact | Use for |
|---|---|---|
| Documentation | https://docs.finternetlab.io/documentation/ | Concepts, guides, use cases |
| API reference (public) | https://docs.finternetlab.io/api-reference/ | Endpoint docs. Examples there use the placeholder host `api.finternetlab.io`; use the real API base from the table above instead. |
| Changelog & roadmap | https://docs.finternetlab.io/changelog/ | Release notes, breaking changes |
| Community | Discord: https://discord.com/invite/x44vzPHmJ2 | Questions, announcements |
| Email | **engineering@finternetlab.io** | Onboarding requests, environment access, protected scopes, bug reports, responsible disclosure (acknowledged within two business days) |

**Rules of thumb**
- Build and test against **Sanctum** (portal `sanctum.finternetlab.io`, API `units.sanctum.finternetlab.io`). Move to **Production** (`my.` / `units.finternetlab.io`) only when ready.
- **Everything is per environment.** Your account, your developer token, your token classes and your tokens on Sanctum don't exist on Production. Repeat the setup there.
- The web portal and the API are different hosts. You log in and manage credentials on the **portal**; your code calls the **API** host.
- Internal platform services are not reachable by integrators, and you never need them.

## 2. Creating your account on the portal

Your portal account is a normal UNITS account. It usually becomes your organisation's **operator account**: the account that registers your token classes, owns your API clients, and performs platform-level writes. Create it with an email or Google identity your organisation controls, such as `units-ops@yourco.com`, not a personal address.

### 2.1 Sign-up on Sanctum (email/phone OTP)

1. Open https://sanctum.finternetlab.io and choose **Log in**.
2. Enter an **email or phone number**. Phones use E.164 format, e.g. `+919876543210`. You can use the same contact later for API login.
3. Enter the OTP (`123456` works on Sanctum). The portal checks with the central registry whether you already have an account.
4. **New user:** if asked, pick a **home instance**, i.e. the region your account lives in, such as "India". Then fill in:
   - **Address**: your account handle, lowercase `a–z 0–9 . _ -`, e.g. `acme-ops`. **Write it down.** It can't be changed, the API needs it (see §6.2), and it's shown masked afterwards.
   - **Name**: letters and spaces only.
   - Accept the **Terms of Use** and **Privacy Notice**. The scroll-gated review is recorded through `/v1/terms/accept`.
5. You land on the **Dashboard**. Existing users go straight there.

### 2.2 Sign-up on Production (Google SSO)

1. Open https://my.finternetlab.io and choose **Continue with Google**.
2. New users then pick a home instance, address and name and accept the terms, as above.
3. Production has **no email/phone OTP form in the portal**. Your code can still log users in with `/v1/account/login` (OTP) against the API, with a real OTP. This is an API-level path; it hasn't been verified against prod in this snapshot.

### 2.3 Behind the scenes

- **Login** is OTP-first: the central registry sends and verifies the OTP, and the portal routes your session to your home instance. The session JWT stays server-side, so your browser JS never sees it.
- **Google SSO**: the portal verifies your Google sign-in and logs you in to UNITS. This path is first-party only; integrators use OTP login via the API.
- **Signup** creates your DID (`did:units:0x…`), a server-custodied Ed25519 signing key (keys are custodied in Vault), encrypted PII, and your login identity.
- **Sessions:** the access token lives about 10 h, but the session goes idle after **30 minutes** without a refresh. If the portal logs you out, just log in again.

## 3. Tour of the portal

The sidebar shows **Dashboard · Tokens · Transactions · API Access**, plus **Approvals** for super-admins only. Profile, credentials and wallets are reached from the profile menu and dashboard.

| Page (path) | What you can do | Notes |
|---|---|---|
| **Dashboard** (`/dashboard`) | Overview of your tokens and activity; auto-refresh toggle | |
| **Tokens** (`/tokens`, `/tokens/details`) | See every token where you're an identity (owner, issuer…): balance (`state.balance`), class, metadata, data, identities, commitment | Read via `/v1/token/search`. Specialised views exist for **credentials** (`/tokens/credential-details`), **loan tokens** and **loan pools** |
| **Transfer** (`/transfer/[tokenId]`) | Send a token to another UNITS address | Recipient resolved through the registry. You sign with **inline OTP "Verify to sign"** (custodial `/v1/account/sign`) or an MPC/passkey wallet. Calls `/v1/token/transact {operation:"transfer"}`. Transfers failed on Sanctum in Aug 2026 (`recipient_address_not_found`); see `known-gaps.md` |
| **On-chain transfer** (`/transfer/onchain`) | Move proxy assets (e.g. USDC on Base) on-chain through the chain adapter | For tokens imported from linked wallets |
| **Transactions** (`/transactions`, `/transactions/details`) | Your ledger history with direction, counterparty and status | `/v1/transaction/search`, `/v1/transaction/get` |
| **Add credentials / KYC** (`/add-credentials`) | Do a KYC journey with an integrated provider (**Signzy** India/UAE/Global, **SumSub** Global). On success a soulbound **`CREDENTIAL`** token (W3C VC, masked name and document number) is minted to you. | One active journey at a time (409 `JOURNEY_EXISTS`). Status: initiated → in_progress → callback_received → processing → completed / failed / cancelled / expired. The VC is added through `/v1/token/add` by the portal backend. |
| **Wallets** | (a) **Link an external wallet** (MetaMask, Coinbase, Phantom… via WalletConnect/AppKit): registers the key with UNITS (`/v1/account/keys/register`), and your on-chain holdings of supported assets are **auto-imported as proxy tokens** (USDC, USDT, ETH…). (b) **MPC passkey wallet** (Silence Labs) for device-bound signing. | Re-adding a proxy token refreshes its balance. MPC isn't required at signup. |
| **Profile** (`/profile`) | Name, masked contact, DID, home instance, consents; update name/email/mobile (OTP-verified workflow) | Address/email shown **masked**; there's no way to display the plaintext address later |
| **API Access** (`/clients`, `/clients/register`, `/clients/details`, `/clients/edit`) | **Register API clients, get developer tokens, manage scopes, rotate secrets, deactivate/reactivate** | See §4–§5 |
| **Approvals** (`/clients/approvals`) | Super-admins only: approve or reject **protected** scope requests | Not visible to integrators |
| **Consent** (`/consent`) | Approve a third-party app's "Login with Finternet" request | See §8. Off by default. |

If **API Access** is missing from your sidebar, the feature is not enabled on that environment or build. Use §4.3 instead.

## 4. Getting API access (a developer token)

A **developer token** identifies your *application* to UNITS. Every API call carries it in the JSON body as `context.developerToken`. Its format is `base64("sa-<client-uuid>:<client-secret>")`, so it always starts with `c2Et`. Your code also needs a **user session JWT** for most calls (see `auth-and-onboarding.md`).

### 4.1 Path A: self-serve on the portal (recommended)

1. Log in to the portal for your target environment (§2). The account you use becomes the **owner** of the client.
2. Sidebar → **API Access** → **Register client** (page title "New API client").
3. **Step 1 · Identify this client.** Enter a **Name** (required, ≤ 255 characters, e.g. "ACME Lending Backend") and an optional **Description**. Super-admins also see an **Owner** field for registering on behalf of another account; you won't.
4. **Step 2 · Choose a preset**, then fine-tune:

   | Preset | Grants (public resources only) | Good for |
   |---|---|---|
   | **Read-only** | every `…:view` | Dashboards, auditors, verifiers |
   | **Standard** | `…:view` + `…:create` | Issuing (mint/add) without other writes |
   | **Full public** | `view` + `create` + `manage` + `transact` | A typical integration backend |
   | **Custom** | nothing preselected | Least-privilege setups |

5. **Step 3 · Grant scopes.** It's a grid of resource × action; use search to find scopes. **Public** scopes are granted immediately. **Protected** scopes (`internal:manage`, `terms:manage`, `*`) show a protected badge and go **pending** until a Finternet super-admin approves them. Integrators almost never need protected scopes.
6. Submit. A **Credentials** dialog appears **once**:
   - **Client ID** (UUID)
   - **Service-account client ID** (`sa-<uuid>`)
   - **Client secret**
   - **Developer token**, i.e. base64 of `"sa-<uuid>:<secret>"`. This is the value you send.

   Use **Download** to save a `<name>-credentials.txt`, or copy the values. **The secret can't be shown again.** If you lose it, rotate (§5).
7. Store the developer token in your **server-side secret store** (env var / vault). Never put it in a browser or mobile bundle, a repo, or a ticket.
8. Check it works with a call such as `/v1/scopes/search` or `/v1/account/login {username}`. See `integration-playbook.md` Step 1.

Your client's **owner address** is your portal account. That matters because a few endpoints accept SA-only calls and then act as the client owner (e.g. `/v1/token/get`, `/v1/token/transact`, `/v1/tokenclass/register`).

### 4.2 Which scopes to pick

Scopes are `entity:action` (`view` / `create` / `manage`, plus `tokens:transact`). There's no hierarchy, so `tokens:manage` does **not** imply `tokens:view`.

| Integration type | Minimum scopes |
|---|---|
| **Any integration** (users log in/sign up through your app) | `accounts:create`, `accounts:manage`, `accounts:view` |
| **Define your own token classes** | `tokenClasses:create`, `tokenClasses:view`, `tokenClasses:manage`, `tokenClassConfigs:create`, `tokenClassConfigs:view`, `tokenClassConfigs:manage`, `registry-programs:view` |
| **Issue tokens / credentials** (mint, add) | `tokens:create`, `tokens:view` |
| **Operate on tokens** (transfer, burn, freeze, lock, loan ops, update) | `tokens:transact`, `tokens:view` |
| **Signed transacts** (register users' signing keys) | `keys:create`, `keys:view` |
| **Consent / third-party access** (delegations) | `workflows:create`, `workflows:view`, `delegations:view` |
| **Terms acceptance in your own UI** | `terms:view`, `terms:create` |
| **Proxy stablecoins / chains** | `registry-chains:view` (+ `tokens:create` for `/token/add`) |
| **Read-only verifier / auditor** | `tokens:view`, `tokenClasses:view`, `accounts:view` |

A missing scope gives `403 CLIENT_INSUFFICIENT_SCOPE: service account does not have required scope: <scope>`. Add it with **Edit** on the client (§5). The full api-id → scope map is in `auth-and-onboarding.md` §8.

You can further restrict a client with **`allowedOperations`** (API only, not in the portal form), e.g. allow only `transfer` and `burn` on `tokens:transact`: `{"tokens:transact":{"payload.operation":["transfer","burn"]}}`.

### 4.3 Path B: ask Finternet (when the portal isn't an option)

Email **engineering@finternetlab.io** with:
- your name and organisation
- what you're building
- which environments you need (Sanctum, Production)
- the scopes from §4.2
- the address of the UNITS account that should own the client

The team registers the client (with a super-admin token, optionally "on behalf of" your account) and sends the developer token securely, along with the API base URL and the OpenAPI link. Use this path for **protected scopes**, Production when the portal path isn't enabled, or org-level arrangements.

### 4.4 Path C: local development

A locally run stack seeds fixed **dev-only** service-account credentials, in `units-api/manifests/docker-compose/registry/initdb/10-local-dev-credentials.sql`. They're deliberately limited (accounts only). See `local-development.md` §3–§4. Never use them anywhere else.

## 5. Managing your API clients (portal → API Access)

| Action | Where | What happens |
|---|---|---|
| **List** clients | API Access | Stat cards (active / deactivated), each client's scopes with status chips, the `sa-<uuid>` id |
| **View details** | Client → Details | Status, every scope with status **active / pending / rejected** and who/when, created by, owner |
| **Edit** name / description / scopes | Client → Edit | Scope changes use **replace** semantics: send the full desired set. New public scopes activate at once; new protected ones go pending. |
| **Rotate secret** | Client → Details → **Rotate secret** | You get a new secret and developer token (shown **once**, downloadable). With **grace seconds**, the **old** token keeps working until `oldSecretValidUntil`, so you can roll deployments without downtime. 0 revokes the old one immediately. |
| **Deactivate** | Client → Deactivate | The credential is blocked within about 15 s (resolver cache). Use it when a token leaks, then rotate or create a new client. |
| **Reactivate** | Client → Reactivate | Restores a deactivated client |

Several of these API ids have no scope mapping for ordinary clients. Calling `/v1/clients/rotate-secret`, `/reactivate` or `/scopes/update` **directly** with your own token can return `500 SCOPE_MAPPING_NOT_CONFIGURED`, so **use the portal for client management**, or ask Finternet.

**Security practices**
- Use one client per backend service, with least-privilege scopes.
- Keep separate clients per environment. They have to be separate anyway.
- Rotate on a schedule and immediately on suspected exposure, using the grace period.
- Never log `context.developerToken` or user JWTs. Redact them in request logs.
- The developer token is a **server credential**. Mobile and web front-ends must call your backend, which then calls UNITS.

## 6. After you have credentials

### 6.1 The two-credential model in your code

```json
{
  "context": {
    "id": "api.token.mint", "version": "1.0", "ts": "2026-10-03T10:00:00Z", "msgId": "<fresh uuid>",
    "developerToken": "<your developer token from the portal>",
    "authorization": "Bearer <user session JWT from /v1/account/login>",
    "valueFormat": "raw"
  },
  "payload": { "...": "..." }
}
```

- `developerToken`: your app, from §4. On **every** call.
- `authorization`: a user session. For platform writes, use your **operator account**, the same account you used on the portal. Log it in through the API with `/v1/account/login` (OTP to its email/phone). On Sanctum use OTP `123456`. On Production, since the portal is Google-only, the API OTP login still works with a real OTP sent to the account's contact.

### 6.2 Record your operator identity

UNITS authorises by `sha256(lower(trim(address)))`, the hex hash of your account **address**. It's also the JWT's `preferred_username`. The portal and `/v1/account/get` show the address **masked**, so:
- Keep the address you chose at signup (§2.1 step 4).
- Or decode `preferred_username` from your session JWT to get the hash directly.

### 6.3 Typical first hour on Sanctum

1. Portal: sign up as `acme-ops` and register a client with the **Full public** preset. Save the developer token.
2. Run `examples/quickstart.sh` with `UNITS_BASE_URL=https://units.sanctum.finternetlab.io`, `UNITS_DEVELOPER_TOKEN=…` and `UNITS_EMAIL=<operator email>`. It logs in, registers a class and config, mints, polls and reads.
3. Open the portal's **Tokens** and **Transactions** pages as the same account to see the result.
4. Continue with `integration-playbook.md`.

## 7. Moving to Production

| Step | Detail |
|---|---|
| 1. Create the production operator account | https://my.finternetlab.io with **Google SSO**, using an org-controlled Google account |
| 2. Register production API clients | Portal → API Access (or email engineering@finternetlab.io). Use new clients; Sanctum tokens don't work on Production |
| 3. Re-register token classes and configs | Classes are per environment. Freeze schema, decimals and names before the first production mint |
| 4. Switch base URL | `https://units.finternetlab.io` |
| 5. Real OTPs | No `123456`. Users receive real OTPs; respect OTP rate limits (429) |
| 6. Build skew | Production may run an older build than Sanctum. Re-test anything environment-dependent, such as transact signature enforcement and loan `value` vs `amount` (`troubleshooting.md` §E) |
| 7. Monitoring | Your own polling/alerting on `/v1/transaction/status`. There are no webhooks |

## 8. "Login with Finternet" (OIDC) for third-party apps

UNITS can act as an **OpenID Connect provider**: users of *your* app click "Login with Finternet", approve a consent screen on the Finternet portal (`/consent`), and your app receives standard OIDC tokens. Optionally, scoped access (label-based delegations) to selected tokens is materialised at consent.

| Item | Detail |
|---|---|
| Status (Oct 2026) | Implemented but not enabled on public environments. Ask Finternet to enable it and onboard you |
| Onboarding | Finternet registers your app as an OIDC client: redirect URIs, grant types (`authorization_code` + PKCE recommended, `refresh_token`), scopes `openid profile email …` |
| What your app can call with the user's token | Allowlisted APIs only: `token/get`, `token/search`, `token/transact`, `token/transactions`, `transaction/status|get|search`, `account/get`, and only on tokens the user delegated (when enforcement is on) |
| Details | `auth-and-onboarding.md` §10, `workflows-and-services.md` §14 |

## 9. Troubleshooting access

| Symptom | Cause | Fix |
|---|---|---|
| Portal or API unreachable in the evening or on a weekend (Sanctum) | The sandbox is available ~08:00–21:00 IST Mon–Fri | Retry in working hours, or develop against a local stack |
| No email/phone OTP form on `my.finternetlab.io` | Production portal is **Google SSO only** | Use Google; API OTP login still works |
| OTP never arrives | Wrong contact format, or a rate limit | Phones in E.164 (`+91…`); wait and retry; on Sanctum just enter `123456` |
| No **API Access** in the sidebar | API Access not enabled on that build or environment | Email engineering@finternetlab.io (§4.3) |
| Scope shows **pending** | It's a protected scope | Wait for super-admin approval, or remove it if not needed |
| Lost the client secret or developer token | Shown once only | Rotate secret (§5), then update your deployment |
| `401 invalid developer token` | Wrong environment, rotated past grace, or deactivated | Check the env/token pairing; rotate or reactivate |
| `403 CLIENT_INSUFFICIENT_SCOPE` | Client lacks a scope | Edit the client and add it (§4.2) |
| `403 … requires a superadmin service account (interim governance)` | You called `/v1/clients/register` directly | Use the portal's API Access page, or email Finternet |
| `500 SCOPE_MAPPING_NOT_CONFIGURED` on rotate/reactivate/scopes | Those api ids are unmapped for normal clients | Do it in the portal |
| `409 FORWARD` on API login | The account lives on another instance (federation) | Call the API base of the account's home instance |
| Portal says `FED_INSTANCE_UNRESOLVED` | Session lacks a known home instance | Log out and back in |
| `TERMS_CONSENT_REQUIRED` | New terms version published | Accept in the portal, or call `/v1/terms/get` + `/v1/terms/accept` |
| Can't find your address later | The portal shows it masked | Use the one you recorded, or decode `preferred_username` (the hash) from your JWT |

## 10. Quick answers

- **Is there a self-serve developer portal?** Yes. The Finternet web app (`sanctum.` / `my.finternetlab.io`) → **API Access**.
- **Do I need to talk to anyone to start?** No, on Sanctum. You need Finternet for protected scopes, OIDC onboarding, custom token programs, commercial terms, or if API Access is disabled.
- **Is the developer token the same as my login?** No. The developer token identifies your *app*; your login (session JWT) identifies a *user*. Most calls need both.
- **Can one token work on Sanctum and Production?** No. Each environment has its own registry, accounts and clients.
- **Are there SDKs?** No official SDK. Use the clients in `../examples/` (TypeScript and Python), curl, or Postman.
- **Is there a cost or quota?** Rate limits apply per client tier and scope (429 with `Retry-After`). Commercial terms come from Finternet.
