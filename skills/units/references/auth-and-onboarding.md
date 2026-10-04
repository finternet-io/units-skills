# UNITS — Authentication, Onboarding, Signing and Authorization

Snapshot: 2026-10-03 (units-api HEAD around Sep/Oct 2026, plus live behaviour seen on sanctum in Aug 2026). Some checks differ per environment, so check behaviour against the instance you are using. When this file says **environment-dependent**, the code and the live sandbox have been seen to behave differently.

Contents
1. [Credential layers at a glance](#1-credential-layers-at-a-glance)
2. [Developer token (service account)](#2-developer-token-service-account)
3. [Onboarding an external organisation](#3-onboarding-an-external-organisation)
4. [End-user sign-up and login flows (full JSON)](#4-end-user-sign-up-and-login-flows)
5. [Identity hashing: address -> stored identity](#5-identity-hashing)
6. [Session lifecycle: refresh, logout, expiry](#6-session-lifecycle)
7. [Envelope signatures for `/v1/token/transact`](#7-envelope-signatures)
8. [Scopes: service-account and user scopes](#8-scopes)
9. [Resource authorization: owners, identities, delegations](#9-resource-authorization)
10. [OIDC third-party sessions ("Login with Finternet")](#10-oidc-third-party-sessions)
11. [Terms and consent](#11-terms-and-consent)
12. [Federation: home instance, FORWARD, registry](#12-federation)
13. [Environment-dependent checks](#13-environment-dependent-checks)
14. [Troubleshooting matrix](#14-troubleshooting-matrix)

---

## 1. Credential layers at a glance

| # | Credential | Identifies | Exact format | Where it goes | Lifetime | How you get it |
|---|---|---|---|---|---|---|
| 1 | **Developer token** (service-account / "SA" credential) | The integrating **application** (API client) | `base64std("sa-<client-uuid>:<clientSecret>")`. Always starts with `c2Et` (the base64 of `sa-`). Padding is optional, and a leading `Basic ` prefix is stripped. | `context.developerToken` in the JSON body of **every** call. It is never sent as a header. | Until you rotate or deactivate it. Rotation can keep the old secret valid for `graceSeconds`. Deactivation takes effect within the resolver cache TTL (seconds). | `POST /v1/clients/register` or `/v1/clients/rotate-secret`. The plaintext is shown once. Today a superadmin must register it for you (see §3). |
| 2 | **User session JWT** | An end-user **account** (a person or business) | Keycloak RS256 access token, realm `finternet`, client `units`. Claims include `sub`, `azp`, `preferred_username` (= sha256 address hash), `email`, `instance_url`, `vault_entity_id`, `resource_access.units.roles` (user scopes). | `context.authorization: "Bearer <jwt>"` in the body. The HTTP `Authorization` header is **not read**. | Access token about 10 h (`expiresIn: 36000`, capped by the SSO max lifespan). Refresh token idles out after **30 min** (`refreshExpiresIn: 1800`). Refresh tokens are **single-use**. | `/v1/account/login` (OTP verify), `/v1/account/create` (returned inline), `/v1/account/refresh` |
| 3 | **OTP JWT** | A verified contact (email or phone) that **has no account yet** | RS256 or EdDSA JWT from otp-service (`iss: otp-service`, claims `username`, `channel` email\|sms, `authMethod` otp\|authToken, `typ: Bearer`). It has no `instance_url` and no account roles. | `context.authorization: "Bearer <otp-jwt>"`, **only** on `/v1/account/create`. It is also accepted on `/v1/account/login` as a fast path that skips OTP re-verification. | Short (minutes) | `/v1/account/login {username, otp}` returns it in `accessToken` when `isExisting:false` |
| 4 | **Envelope signature** | Proof that the account holder approved this exact payload | `{"keyId":"<key_references uuid>","jws":"<std-base64 raw 64-byte Ed25519 signature over JCS(payload)>"}`. Despite the name, `jws` is **not** a compact JWS. | Top-level `signature` field, a sibling of `context` and `payload` | One per request. It is bound to the exact payload. | A key you register with `/v1/account/keys/register`, or custodial signing via `/v1/account/sign` (OTP, two-phase) |
| 5 | Web-app `authToken` (first-party SSO only) | A Google-SSO-verified email, asserted by the Finternet web app | Short-lived JWT issued by the Finternet web app | `payload.authToken` on `/v1/account/login` | Minutes | Only the Finternet web app uses this path. External integrators **cannot** use it. |
| 6 | ULIP peer signatures | A UNITS **instance** (instance-to-instance federation) | Ed25519-signed ULIP envelopes `{context:{ulip_version,method,txn_id,op_seq,...}, payload:{type_url,value}, signature:{signer_instance,key_name,algorithm,signature}}` | `/v1/ulip/*` and `/v1/internal/primitives/complete` | Per message | Instance keys published at `/.well-known/ulip.json` and `/.well-known/jwks.json`. **Not for integrators.** |

Other things integrators sometimes see:
- **Step-up OTP token (`stepUpToken`)**. It was **removed** (PR #284). The payload schemas are closed, so sending it returns 400.

Two rules that cause most auth bugs:
1. **Both tokens go in the body.** `{"context":{"developerToken":"c2Et...","authorization":"Bearer eyJ..."}}`. The only header units-api reads is optional `X-Correlation-ID`, plus `Content-Type: application/json`. Older docs and OpenAPI text describe `Authorization: Bearer <devToken>` and `X-Finternet-Signature` headers. Those are stale.
2. **GET endpoints are unusable under SA auth.** A GET has no envelope, so it cannot carry a developer token, and every GET except `/v1/health` and `/.well-known/*` returns 401. Use the POST equivalents.

---

## 2. Developer token (service account)

### 2.1 Format and how the server checks it

```
clientId       = "sa-" + <lowercase UUID of the registry developer_clients row>
clientSecret   = 32 random bytes, base64url  (43 chars)
developerToken = base64std(clientId + ":" + clientSecret)        -> "c2Et..."
```

On every request, units-api:
1. Base64-decodes the token (std, padding optional, optional `Basic ` prefix stripped), splits it on the first `:`, and checks that the `sa-<uuid>` shape is valid.
2. Computes `hex(sha256(clientId + ":" + clientSecret))` and resolves it at the **central registry**. The registry returns a registrar-signed *CredentialBundle* `{ClientID, OwnerAddresses[], Scopes[], AllowedOperations, IsSuperAdmin, RateLimitTierID}`. Results are held in a short, fail-closed cache.
3. Checks the route's required scope (from the registry `scope_apis` mapping of the route's api id) and then `allowedOperations`. Superadmin SAs skip both checks.
4. Applies the rate limit for the SA's tier and the scope.

The registry is authoritative for its federation, so a token minted for instance A also works on instance B **of the same environment**. Each environment runs its own registry (prod `registry.finternetlab.io`, sanctum `registry.sanctum.finternetlab.io`), so a sanctum developer token does **not** work on prod, and vice versa. Ask for one client per environment and keep the secrets separate.

| Failure | HTTP | `context.error.code` | message |
|---|---|---|---|
| Token missing or empty | 401 | `UNAUTHORIZED` | `Unauthorized. Developer token is missing or empty` |
| Malformed, unknown, revoked, or the client is deactivated | 401 | `UNAUTHORIZED` | `invalid developer token` |
| Registry unreachable or bundle verification failed | 503 | `EXTERNAL_SERVICE_ERROR` | `registry service unavailable` |
| SA lacks the scope for this api id | 403 | `CLIENT_INSUFFICIENT_SCOPE` | `service account does not have required scope: <scope>` |
| Body value blocked by `allowedOperations` | 403 | `FORBIDDEN` | `client is not allowed to perform this operation` |
| Api id has no scope mapping in the registry (non-superadmin) | 500 | `SCOPE_MAPPING_NOT_CONFIGURED` | — |
| Rate limit exceeded | 429 | `TOO_MANY_REQUESTS` | `rate limit exceeded` (plus a `Retry-After` header) |

### 2.2 Handling rules
- Keep the token **server-side only**. Do not put it in browser bundles or mobile apps, and do not log it.
- units-api does **not** accept OAuth client-credentials tokens. Always send the developer token.
- Local dev: `units-api/manifests/docker-compose/registry/initdb/10-local-dev-credentials.sql` seeds two fixed **dev-only** SA credentials (`local-dev-manage` with `accounts:create|manage|view`, and `local-dev-noscope`). Look them up there and never use them outside a local stack. Older scripts use `dev_pk_test_token`, and older docs use `fnt_...` or `dev-token-...`. Those formats are obsolete and return 401.

---

## 3. Onboarding an external organisation

### 3.1 What you need to end up with

| Item | Purpose | Notes |
|---|---|---|
| Base URL of the target instance | Where calls go | Sandbox (staging "Sanctum"): `https://units.sanctum.finternetlab.io`. It is available ~08:00 to 21:00 IST on weekdays. Prod: `https://units.finternetlab.io`. Dev "Foundry": `https://units.foundry.finternetlab.io` (not a supported integration target). Do not invent other hosts. |
| **Developer token** for your API client | Every call | It needs the scopes listed in §3.4 |
| An **operator account** | A real UNITS user account owned by your org. It registers your token classes and performs platform-level writes (mint and transact). | One stable account. Whoever registers a class owns it. |
| End-user accounts | Each person or business that owns tokens such as credentials | Created through OTP sign-up (§4). Record their plaintext address and its hash at sign-up. |
| An Ed25519 signing key per account that calls `/v1/token/transact` | Envelope signature | §7. It may be environment-dependent, but build it anyway. |

### 3.2 Getting a client / developer token

The step-by-step portal walkthrough, scope presets and client management is in [portals-and-access.md](portals-and-access.md).

**Path A: self-serve in the Finternet web portal (recommended)**
1. Log in at the environment's portal: `sanctum.finternetlab.io` (sandbox; email/phone OTP or Google) or `my.finternetlab.io` (production; Google SSO). The account you use becomes the client **owner**, normally your operator account.
2. Open the sidebar and go to **API Access → Register client**. Enter a name and description, choose a preset (Read-only / Standard / Full public / Custom) and adjust the scopes. The portal backend makes the registration call with its own platform-level service account, so you don't need a bootstrap token and the superadmin rule below doesn't block you.
3. A Credentials dialog shows `clientSecret` and `developerToken` **once**, with a download button. Its text reads "Developer token (base64 of "<keycloakClientId>:<secret>") … Send the developer token as context.developerToken on every API call".
4. The client details page shows status, each scope's state (active, pending or rejected, with who and when), **Rotate secret** (with grace seconds) and **Deactivate/Reactivate**. Protected scopes stay pending until a super-admin approves them on the **Approvals** page.

**Path B: ask the Finternet platform team** (if API Access is disabled on the environment, for protected scopes, or for create-on-behalf)
1. Create the user account that will own the client: OTP sign-up on the portal or through the API (§4).
2. Send engineering@finternetlab.io (or your Finternet contact) the following: org name, client name, environment, the owner account's **plaintext address** (e.g. `acme-ops`), the scopes you need (§3.4), and any `allowedOperations` restrictions.
3. A platform operator calls `/v1/clients/register` with a superadmin developer token, either with your session JWT in `context.authorization` or on your behalf with `identities:[{"type":"owner","address":"acme-ops"}]`.
4. You receive `clientId`, `keycloakClientId` (`sa-<uuid>`), `clientSecret` and `developerToken`. **The plaintext is shown once.** Store it in a secret manager.

**Why not call the API directly?** `POST /v1/clients/register` with an ordinary client's token returns 403 FORBIDDEN *"client registration currently requires a superadmin service account (interim governance); ask a platform operator to register the client"*. Similarly, `/v1/clients/rotate-secret`, `/reactivate` and `/scopes/update` are unmapped for normal clients (500 `SCOPE_MAPPING_NOT_CONFIGURED`). Use the portal for client management.

The register request that the operator or the web app sends:

```json
{
  "context": {
    "id": "api.clients.register", "version": "1.0", "ts": "2026-10-03T10:00:00Z",
    "msgId": "7f1d2c3a-1b2c-4d5e-8f90-0a1b2c3d4e5f",
    "developerToken": "<superadmin developer token>",
    "authorization": "Bearer <owner's session JWT>"
  },
  "payload": {
    "name": "Acme Lending Integration",
    "description": "Acme loan-servicing backend (sandbox)",
    "scopes": ["accounts:create", "accounts:manage", "accounts:view",
               "tokens:view", "tokens:create", "tokens:transact",
               "tokenClasses:view", "tokenClasses:create", "tokenClasses:manage",
               "tokenClassConfigs:view", "tokenClassConfigs:create", "tokenClassConfigs:manage",
               "registry-programs:view",
               "keys:view", "keys:create", "delegations:view",
               "workflows:create", "workflows:view", "terms:view", "terms:create"],
    "allowedOperations": {
      "tokens:transact": { "payload.operation": ["loan_disbursed", "payment_received", "cersai_registered"] }
    },
    "identities": [ { "type": "owner", "address": "acme-ops" } ]
  }
}
```

Payload rules (`register_client_request.json`, closed):

| field | type | required | notes |
|---|---|---|---|
| `name` | string 1–255 | yes | |
| `description` | string up to 1000 | no | |
| `scopes` | string[] | no | Public scopes become `active` immediately. Protected scopes (`internal:manage`, `terms:manage`, `*`) start `pending`. |
| `allowedOperations` | object `{scope: {dotPath: [values]}}` | no | See §8.3 |
| `identities` | array, at most 1, `{type:"owner", address:"<PLAINTEXT>"}` | no | Create-on-behalf: a superadmin can set an owner other than the caller. Do not supply the creator; the server derives it. |

Response (201/200):

```json
{
  "context": { "id": "api.clients.register", "version": "1.0", "ts": "2026-10-03T10:00:01Z",
               "msgId": "7f1d2c3a-1b2c-4d5e-8f90-0a1b2c3d4e5f", "status": "successful" },
  "response": {
    "clientId": "0199c0de-1111-7aaa-8bbb-123456789abc",
    "keycloakClientId": "sa-0199c0de-1111-7aaa-8bbb-123456789abc",
    "clientSecret": "<43-char secret, shown once>",
    "developerToken": "c2EtMDE5OWMwZGUt...",
    "name": "Acme Lending Integration",
    "status": "active",
    "creator": { "accountId": "<uuid>", "address": "acme-ops" },
    "owner":   { "accountId": "<uuid>", "address": "acme-ops" },
    "scopes": [
      { "scope": "tokens:view", "status": "active" },
      { "scope": "tokens:transact", "status": "active" }
    ],
    "createdAt": "2026-10-03T10:00:01Z"
  }
}
```

### 3.3 Protected scopes and approval
- Protected scopes are `internal:manage`, `terms:manage` and `*`. They go `pending` until a superadmin reviews them. Pending requests expire through a registry sweep (about 7 days).
- List pending entries with `POST /v1/scope-approvals/` (note the trailing slash; api id `api.scope-approvals.list`; scope `clients:manage`). Payload: `{"status":"pending","clientId":"<uuid>"}`, where both fields are optional. Superadmins see all clients, owners see their own clients, and others see only what they requested.
- A superadmin approves or rejects with `POST /v1/workflows/execute`:

```json
{ "context": { "id": "api.workflow.execute", "version": "1.0", "ts": "...", "msgId": "...",
               "developerToken": "<superadmin token>", "authorization": "Bearer <superadmin user JWT>" },
  "payload": { "workflow": "scope-approval", "action": "reviewed",
               "data": { "clientId": "0199c0de-1111-7aaa-8bbb-123456789abc",
                         "scopes": [ { "scope": "terms:manage", "status": "approved", "reason": "consent admin" } ] } } }
```
- The requester can withdraw with `{"workflow":"scope-approval","action":"cancel","data":{"clientId":"<uuid>","scopes":["terms:manage"]}}`. If `scopes` is omitted, all of the caller's pending requests on that client are cancelled.
- Integrators should **not** need protected scopes.

### 3.4 Scopes to request (typical integrator)

| You want to… | Scopes |
|---|---|
| Sign up and log in end users, read profiles | `accounts:create` (create), `accounts:manage` (login, refresh, update, OTP, PII decrypt), `accounts:view` (get, logout, address check and resolve) |
| Accept terms on behalf of users | `terms:view`, `terms:create` |
| Register signing keys and sign custodially | `keys:create` (register), `keys:view` (get, search), `keys:manage` (remove, `/account/sign`) |
| Register your own token classes and configs | `tokenClasses:create`, `tokenClasses:view`, `tokenClasses:manage` (update), `tokenClassConfigs:create`, `tokenClassConfigs:view`, `tokenClassConfigs:manage` (update) |
| Choose a program | `registry-programs:view` |
| Mint and import tokens | `tokens:create` (covers both `/token/mint` and `/token/add`) |
| Any `/token/transact` operation (transfer, burn, freeze, lock, domain ops, update) | `tokens:transact` (`update` additionally needs the **resource** permission `manage` on the token, which the owner has; that is an OPA check, not a client scope) |
| Read tokens, transactions, proofs and the federation status | `tokens:view` (also covers `/transaction/*`, `/transactions/status`, proofs) |
| Delegations | `workflows:create` (create, approve, revoke via `/workflows/execute`), `workflows:view`, `workflows:manage` (cancel), `delegations:view` (list, check) |
| Manage your own clients | `clients:view`, `clients:manage` |
| Read the scope catalogue | `scopes:view` |
| Read chains and wallets (proxy tokens) | `registry-chains:view`, `registry-wallets:view` |

Docs that map mint/transfer to `tokens:create`, freeze/burn to `tokens:manage`, or reads to `transactions:view` are **stale**. Use the table above, which comes from the registry `scope_apis` seed. For the full per-endpoint map see `api-reference.md`.

### 3.5 Managing the client afterwards

| Call | Payload | Scope | Notes |
|---|---|---|---|
| `/v1/clients/get` | `{"clientId":"<uuid>"}` | `clients:view` | Returns ClientProfile `{id, name, description, scopes[], allowedOperations, identities, status, isSuperAdmin, keycloakClientId, creator, createdAt, updatedAt}` |
| `/v1/clients/list` | `{}` | `clients:view` | Clients owned by the caller's account |
| `/v1/clients/update` | `{"clientId","name"?,"description"?}` | `clients:manage` | Cannot change scopes |
| `/v1/clients/scopes/update` | `{"clientId","scopes":[...]}` | unmapped, so superadmin only today | **Replace** semantics. New public scopes activate; new protected ones go pending. |
| `/v1/clients/rotate-secret` | `{"clientId","graceSeconds":3600}` | unmapped, so superadmin only today | Returns a new `clientSecret` and `developerToken` (once) plus `oldSecretValidUntil`. `graceSeconds` of 0 or omitted revokes the old one immediately. The value is clamped server-side. |
| `/v1/clients/deactivate` | `{"clientId"}` | `clients:manage` | Invalidates the credentials within the cache TTL. There is no per-key revocation. |
| `/v1/clients/reactivate` | `{"clientId"}` | unmapped, so superadmin only today | |

"Unmapped" means the registry has no `scope_apis` row for that api id. A non-superadmin SA gets **500 SCOPE_MAPPING_NOT_CONFIGURED**, so ask the platform team, or use the web app, which calls with a superadmin token. All `/v1/clients/*` calls also need a user JWT. Mismatched ownership returns 404 rather than revealing that the client exists.

Rotation playbook: call rotate-secret with `graceSeconds` long enough to cover your deploy, then roll the new `developerToken` to every service and confirm the old one stops resolving after `oldSecretValidUntil`.

### 3.6 Choosing and bootstrapping the operator account
- Create it once through the sign-up flow (§4) with a stable org contact (for example `units-ops@acme.com`) and an address such as `acme-ops`. Use `entityType:"BUSINESS"`.
- Store its plaintext address, its hash (§5), its DID (from `/v1/account/get`), and the `keyId` of its signing key (§7).
- Use **this account's** session for: `/tokenclass/register`, `/tokenclassconfig/register`, `/token/mint`, and `/token/transact` on tokens it issues. Classes are owned by whoever registers them, and on classes with identities only the issuer can mint. Using one account avoids `FORBIDDEN no_matching_allow_rule`.
- Operator sessions: OTP login is interactive in production. A fixed OTP (`123456`) works only on non-prod. Keep the session alive with refresh on a timer (§6). For production, ask the platform team about a non-OTP operator path. **None exists today**, and this is a known gap.
- Do **not** pass `identities[]` on mint. It re-hashes the ids and the caller loses rights.

---

## 4. End-user sign-up and login flows

All calls are `POST <base><path>` with header `Content-Type: application/json`. `context.version` is `"1.0"` (spec), and `"v1"` is also accepted live. Use a fresh UUID `msgId` for every attempt.

### 4.1 Flow diagram

```
send OTP ──► /v1/account/login {username}                       → {success:true, message:"OTP sent successfully"}
verify   ──► /v1/account/login {username, otp}
              ├─ isExisting:true  → real session {accessToken, refreshToken, ...}      → done (go to get profile)
              ├─ isExisting:false → OTP JWT in accessToken (no refreshToken)
              │                      └─► /v1/account/create (authorization: Bearer <OTP JWT>)
              │                             {address, name, entityType} → real session
              └─ 409 FORWARD      → account lives on another instance: call that instance's API (§12)
profile  ──► /v1/account/get {}   (authorization: Bearer <session>)  → did, masked address/email, consents[]
terms    ──► /v1/terms/get, /v1/terms/accept   (only if consents[].consentRequired or the instance enforces it)
keys     ──► /v1/account/keys/register (ed25519) → keyId for transact signatures
```

`username` is a **contact**: an email address, or a phone number in E.164 form (`+919876543210`, where a leading `+` selects SMS). It is **not** the account address. Normalise contacts consistently (lowercase emails, E.164 phones), because the registry stores hashes of them.

### 4.2 Step 1: send the OTP

Required scope: `accounts:manage`. No user JWT.

```json
{
  "context": {
    "id": "api.account.login", "version": "1.0", "ts": "2026-10-03T10:00:00Z",
    "msgId": "0b6f9a52-5f7e-4f6a-9d0e-3a3c9b1e2f10",
    "developerToken": "c2Et...<your token>"
  },
  "payload": { "username": "alice@acme.com" }
}
```

```json
{
  "context": { "id": "api.account.login", "version": "1.0", "ts": "2026-10-03T10:00:00Z",
               "msgId": "0b6f9a52-5f7e-4f6a-9d0e-3a3c9b1e2f10", "status": "successful" },
  "response": { "success": true, "message": "OTP sent successfully" }
}
```

The sandbox accepts the fixed OTP `123456` on non-prod instances, but send-OTP may still email or text a real address. Production delivers real OTPs only. OTP rate limits return 429 with code `EXTERNAL_SERVICE_ERROR`.

### 4.3 Step 2: verify the OTP

```json
{
  "context": {
    "id": "api.account.login", "version": "1.0", "ts": "2026-10-03T10:00:20Z",
    "msgId": "a0c1b2d3-0000-4000-8000-000000000002",
    "developerToken": "c2Et..."
  },
  "payload": { "username": "alice@acme.com", "otp": "123456" }
}
```

Existing account (a real Keycloak session):

```json
{
  "context": { "id": "api.account.login", "version": "1.0", "ts": "...", "msgId": "...", "status": "successful" },
  "response": {
    "accessToken": "eyJhbGciOiJSUzI1NiIs...",
    "tokenType": "Bearer",
    "expiresIn": 36000,
    "refreshToken": "eyJhbGciOiJIUzUxMiIs...",
    "refreshExpiresIn": 1800,
    "isExisting": true
  }
}
```

No account anywhere in the federation (`accessToken` is the **OTP JWT**: no refresh token, no account roles, and usable only for `/v1/account/create`):

```json
{
  "context": { "id": "api.account.login", "version": "1.0", "ts": "...", "msgId": "...", "status": "successful" },
  "response": { "accessToken": "eyJhbGciOiJSUzI1NiIs...<otp jwt>", "tokenType": "Bearer", "expiresIn": 300, "isExisting": false }
}
```

(`expiresIn` for the OTP JWT is set by otp-service and is short, so the `300` above is illustrative. Spec examples show `3600` for sessions, while the observed Keycloak value is `36000`. Always read the value rather than hard-coding it.)

Account homed on another instance:

```json
{
  "context": { "id": "api.account.login", "version": "1.0", "ts": "...", "msgId": "...", "status": "failed",
               "error": { "code": "FORWARD",
                          "message": "This account is hosted on a different instance (`<home-instance-uuid>`). Please connect through its API at `https://units-xx.example`" } },
  "response": {}
}
```

Errors: 401 `UNAUTHORIZED` for a wrong or expired OTP (message `otp_invalid`), 429 for the OTP rate limit, and 503 `EXTERNAL_SERVICE_ERROR` when the OTP service or registry is down.

Schema: the `payload` is closed and must match one of three shapes: `{username}`, `{username, otp}`, or `{username, authToken}`. Sending both `otp` and `authToken` returns 400.

### 4.4 Step 3: create the account (new users only)

Required scope: `accounts:create`. `context.authorization` = **the OTP JWT** from step 2. The email or mobile comes from the OTP JWT's `username` claim and is never taken from the payload.

```json
{
  "context": {
    "id": "api.account.create", "version": "1.0", "ts": "2026-10-03T10:01:00Z",
    "msgId": "a0c1b2d3-0000-4000-8000-000000000003",
    "developerToken": "c2Et...",
    "authorization": "Bearer eyJhbGciOiJSUzI1NiIs...<otp jwt>"
  },
  "payload": { "address": "alice.acme", "name": "Alice Smith", "entityType": "PERSONAL" }
}
```

Business variant: `{"address":"acme-ops","name":"Acme Lending","entityType":"BUSINESS"}`.

| field | rule |
|---|---|
| `address` | Your chosen handle, **lowercase**, matching `^[a-z0-9._-]+$`, at most 255 characters. It must be unique across the federation; check with `/v1/address/checkAvailability`. A namespacing pattern such as `<name>-<8hex>.<yourorg>` avoids collisions. |
| `name` | Letters and spaces only, `^[\p{L} ]+$` (no digits or punctuation), 1–100 characters |
| `entityType` | **`PERSONAL` or `BUSINESS`**. `Individual`, `individual` and `INDIVIDUAL` (seen in old Postman collections, docs and app code) fail schema validation on the live API. |
| `signedRegisterNameEnvelope` | Optional. A base64 ULIP envelope signed by the user's own Ed25519 key, for the self-custody sign-up path. Most integrators omit it. |
| `reservationProof` | Optional. A registrar-signed reservation proof (OTP-first federation flow used by the web app). |
| `homeInstance` | Accepted but **ignored**. The instance that receives the call becomes the home. |

Response, a real session that replaces the OTP JWT:

```json
{
  "context": { "id": "api.account.create", "version": "1.0", "ts": "...", "msgId": "...", "status": "successful" },
  "response": {
    "accessToken": "eyJhbGciOiJSUzI1NiIs...",
    "tokenType": "Bearer",
    "expiresIn": 36000,
    "refreshToken": "eyJhbGciOiJIUzUxMiIs...",
    "refreshExpiresIn": 1800
  }
}
```

What the server does: it creates the account row (stored address = sha256 hash; email and mobile hashed; PII encrypted with Vault transit), creates a custodial Ed25519 signing key (custodied in Vault), sets the DID to `did:units:0x<hex(pubkey)>`, registers the key in `key_references`, creates a passwordless Keycloak user whose username is the address hash, seeds all **public** user scopes, registers the name at the central registry (synchronously), and mints a session.

Errors: 400 `INVALID_INPUT` (schema: bad entityType, digits in the name, uppercase in the address), 401 (OTP JWT missing or expired), 409 or `IDENTIFIER_TAKEN` (address already registered).

**Record these now:** `address` (plaintext) and `addressHash = sha256(lower(trim(address)))`. `/v1/account/get` only ever returns the address **masked**, so for an existing user you cannot recover it later except through `/account/pii/decrypt` with that user's session.

### 4.5 Step 4: get the profile

Required scope: `accounts:view`. Session JWT required.

```json
{
  "context": { "id": "api.account.get", "version": "1.0", "ts": "...", "msgId": "...",
               "developerToken": "c2Et...", "authorization": "Bearer <session>" },
  "payload": {}
}
```

```json
{
  "context": { "id": "api.account.get", "version": "1.0", "ts": "...", "msgId": "...", "status": "successful" },
  "response": {
    "did": "did:units:0x5126a965c1...",
    "address": "a***e",
    "email": "a***@acme.com",
    "name": "Alice Smith",
    "phoneNumber": "+9***3210",
    "entityType": "PERSONAL",
    "status": "active",
    "vaultEntityID": "<sha256(accountId)>",
    "homeInstance": "<instance uuid>",
    "createdAt": "2026-10-03T10:01:00Z",
    "pii": {
      "address_encrypted": "vault:v1:...", "address_masked": "a***e",
      "email_encrypted": "vault:v1:...", "email_masked": "a***@acme.com",
      "mobile_encrypted": "vault:v1:...", "mobile_masked": "+9***3210"
    },
    "consents": [ { "docType": "terms_of_use", "currentVersion": 1, "acceptedVersion": 1, "consentRequired": false } ]
  }
}
```

- `did` is `did:units:0x<ed25519 public key hex>`. It is **unrelated** to the address hash, so do not derive one from the other.
- `entityType` may echo whatever the account was stored with (some older accounts show `Individual`).
- To read a plaintext value, call `/v1/account/pii/decrypt {"ciphertext":"vault:v1:..."}` (scope `accounts:manage`, the user's own session; ciphertext belonging to another account is refused). It returns `{"plaintext":"alice.acme"}`.
- `/v1/account/get` is the cheap way to check that a session is alive.

### 4.6 Other account calls

| Call | Payload | Scope | Notes |
|---|---|---|---|
| `/v1/address/checkAvailability` | `{"address":"alice.acme"}` | `accounts:view` | `{available:true}`. An address taken on any federated instance reports unavailable. Developer token only. |
| `/v1/address/resolve` | `{"address":"alice.acme"}` | `accounts:view` | `{address, did}`. This replaces the disabled `GET /v1/did/:address`. |
| `/v1/account/update` | `{"action":"initiate","data":{"name":"Alice B Smith"}}`, then `{"action":"verify_current_ownership","data":{"workflowId","otp","recipient"}}`, `verify_new_email`, `verify_new_mobile`, `cancel` | `accounts:manage` | Profile-update workflow (OTP timeout 10 min). The first step returns 202 `{workflowId:"profile-update-<uuid>", status:"accepted"}`. Consent-gated. |
| `/v1/account/otp/generate` / `/otp/verify {"code":"123456"}` | | `accounts:manage` | OTP to the **signed-in** user's own contact. Requires a session. |
| `/v1/account/logout` | `{}` | `accounts:view` | `{message:"Signout successful"}`. This is a **global** Keycloak logout for that user, and it kills all of that user's sessions, including the web app's. |

### 4.7 Copy-paste client (TypeScript)

```ts
import { randomUUID } from "node:crypto";

const BASE = process.env.UNITS_BASE_URL!;            // e.g. https://units.sanctum.finternetlab.io
const DEV  = process.env.UNITS_DEVELOPER_TOKEN!;     // c2Et...

export async function units<T = any>(path: string, apiId: string, payload: unknown,
  opts: { jwt?: string; signature?: { keyId: string; jws: string }; valueFormat?: "raw" | "display" } = {}) {
  const context: Record<string, unknown> = {
    id: apiId, version: "1.0", ts: new Date().toISOString(), msgId: randomUUID(), developerToken: DEV,
  };
  if (opts.jwt) context.authorization = opts.jwt.startsWith("Bearer ") ? opts.jwt : `Bearer ${opts.jwt}`;
  if (opts.valueFormat) context.valueFormat = opts.valueFormat; // ONLY on token get/search/mint/transact
  const body: Record<string, unknown> = { context, payload };
  if (opts.signature) body.signature = opts.signature;
  const res = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json: any = await res.json().catch(() => null);
  const ok = res.ok && json?.context?.status !== "failed";
  if (!ok) throw Object.assign(new Error(json?.context?.error?.message ?? `HTTP ${res.status}`),
                               { code: json?.context?.error?.code, http: res.status, body: json });
  return json.response as T;
}

// login / signup
await units("/v1/account/login", "api.account.login", { username: "alice@acme.com" });
const v = await units("/v1/account/login", "api.account.login", { username: "alice@acme.com", otp });
let session = v.accessToken, refresh = v.refreshToken;
if (!v.isExisting) {
  const c = await units("/v1/account/create", "api.account.create",
    { address: "alice.acme", name: "Alice Smith", entityType: "PERSONAL" }, { jwt: v.accessToken });
  session = c.accessToken; refresh = c.refreshToken;
}
```

---

## 5. Identity hashing

UNITS stores an account's address as `sha256(lower(trim(address)))` in lowercase hex, with no `0x` prefix. The same value is:
- the Keycloak username and the JWT **`preferred_username`** claim,
- the `id` that appears in token `identities[]` and in delegation grantor and grantee records,
- what `/v1/token/add` expects in `owner` for sessionless issuance, and the convention for `credentialSubject.id`.

It is **not** the DID, and the DID's hex is the public key, not this hash.

**Where to send plaintext and where to send the hash**

| Field | Send |
|---|---|
| `/v1/token/transact` `to` | plaintext address (for example `"alice.acme"`) |
| delegation `grantee_address` | plaintext |
| token class `identities[].id` (register/update) | plaintext (the server hashes it) |
| `/v1/clients/register` `identities[].address` | plaintext |
| `/v1/users/scopes/*` `account.address` | plaintext |
| `/v1/address/checkAvailability`, `/v1/address/resolve` | plaintext |
| `/v1/token/add` `owner` (sessionless B2B issuance) | **hash** |
| W3C VC `credentialSubject.id` (convention) | **hash** |
| comparing with JWT `preferred_username` | **hash** |

### TypeScript (Node)

```ts
import { createHash } from "node:crypto";

export function hashAddress(address: string): string {
  return createHash("sha256").update(address.trim().toLowerCase(), "utf8").digest("hex");
}

export function preferredUsername(jwt: string): string {
  const seg = jwt.replace(/^Bearer\s+/i, "").split(".")[1];
  if (!seg) throw new Error("not a JWT");
  const claims = JSON.parse(Buffer.from(seg, "base64url").toString("utf8"));
  if (!claims.preferred_username) throw new Error("no preferred_username");
  return claims.preferred_username;
}

// After create/login: assert the stored hash matches the session
if (preferredUsername(session) !== hashAddress("alice.acme")) throw new Error("identity mismatch");
```

### Python

```python
import base64, hashlib, json

def hash_address(address: str) -> str:
    return hashlib.sha256(address.strip().lower().encode("utf-8")).hexdigest()

def preferred_username(jwt: str) -> str:
    seg = jwt.removeprefix("Bearer ").split(".")[1]
    seg += "=" * (-len(seg) % 4)                      # restore base64url padding
    return json.loads(base64.urlsafe_b64decode(seg))["preferred_username"]

assert preferred_username(session) == hash_address("alice.acme")
```

### bash / openssl

```bash
addr='  Alice.ACME '
norm=$(printf '%s' "$addr" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | tr '[:upper:]' '[:lower:]')
printf '%s' "$norm" | openssl dgst -sha256 -r | cut -d' ' -f1
# or: printf '%s' "$norm" | sha256sum | cut -d' ' -f1

# preferred_username from a JWT (base64url -> base64)
jwt='eyJ...'; p=$(printf '%s' "$jwt" | cut -d. -f2 | tr '_-' '/+'); while [ $(( ${#p} % 4 )) -ne 0 ]; do p="$p="; done
printf '%s' "$p" | base64 -d | jq -r .preferred_username
```

Notes:
- Use `printf '%s'`, **not** `echo`, because `echo` adds a newline that changes the hash.
- `tr` lowercases ASCII only. The server uses Go `strings.ToLower` (Unicode-aware), but addresses are ASCII by schema anyway.
- Hashing an email or phone the same way gives the stored contact hashes (`email`, `mobile` columns). `/v1/account/sign` uses this to match `username`.

---

## 6. Session lifecycle

| Value | Observed |
|---|---|
| Access token lifetime | about 10 h (`expiresIn: 36000`; the realm allows 24 h but the 10 h SSO max lifespan caps it) |
| Refresh token idle lifetime | 30 min (`refreshExpiresIn: 1800`) |
| Refresh tokens | **single-use**. Presenting a used refresh token **destroys the whole session**. |
| Session validity check | Every request introspects the session, cached for about 30 s. Logout or revocation is effective within that window. |

**Refresh**: `POST /v1/account/refresh` (scope `accounts:manage`). Send **no** `authorization`, because the old access token may be expired.

```json
{
  "context": { "id": "api.account.refresh", "version": "1.0", "ts": "...", "msgId": "...", "developerToken": "c2Et..." },
  "payload": { "refreshToken": "eyJhbGciOiJIUzUxMiIs..." }
}
```

```json
{ "context": { "id": "api.account.refresh", "status": "successful", "...": "..." },
  "response": { "accessToken": "eyJ...", "tokenType": "Bearer", "expiresIn": 36000,
                "refreshToken": "eyJ...(NEW — replace the old one)", "refreshExpiresIn": 1800 } }
```

| Error | Meaning | Action |
|---|---|---|
| 401 `UNAUTHORIZED` | The refresh token is not usable (expired after 30 min idle, malformed, or issued to another client) | Log in again |
| 401 `SESSION_REVOKED` | Reuse detected, so the session and every token in its lineage are gone | Log in again, and fix your concurrency |

**Rules for long-lived sessions (operator, service jobs):**
1. Refresh on a **timer under 30 minutes** (for example every 20 minutes), not when the access token expires. Otherwise the refresh token dies first.
2. Run refresh behind a **single-flight lock** (one in-flight refresh per session across all your workers). Two concurrent refreshes count as reuse and return `SESSION_REVOKED`.
3. Persist the new refresh token atomically before you use the new access token.
4. On any 401 from a business call, refresh once, and if that fails, re-run OTP login. For the operator this means an interactive OTP in production.

---

## 7. Envelope signatures

### 7.1 When a signature is required

| Situation | Behaviour |
|---|---|
| `/v1/token/transact` on an environment that enforces signatures | `signature` is **mandatory**. Missing: 401 `signature with keyId and jws is required`. |
| Any route where you **do** send a `signature` | The server **verifies it**. A bad signature returns 401 even on routes that do not require one. Do not attach stale signatures. |
| Enforcement on transact | **Environment-dependent**. Always build signing in. |
| `/v1/token/mint`, `/v1/token/add` | Not required (older spec text saying mint needs a signature is stale) |

Checks the server performs:
1. `keyId` must parse as a UUID, otherwise 401 `invalid signature key reference`.
2. The key must exist in `key_references`, otherwise `signature key not found`.
3. The key must have `status: "active"`, otherwise `signature key is not active`.
4. The key type must be **ed25519**. secp256k1 keys cannot sign envelopes and return `unsupported signature key type`.
5. The server computes the message as the RFC 8785 **JCS** canonical bytes of the `payload` value it received, base64-decodes `jws` (std alphabet; padded or unpadded both work; **not** base64url), requires exactly 64 bytes, and verifies with the key's 32-byte public key. A failure returns `invalid signature`. If the key row has a `wellKnownUrl`, the active ed25519 keys at `{url}/.well-known/jwks.json` are tried first.
6. If a user session is present, the signing key **must belong to the session's account**, otherwise `signature key does not belong to the authenticated account`.

Because the server canonicalises what it **received**, whitespace and key order in the bytes you send don't matter. **Values** must be identical to what you signed, including the type of every number (`21` vs `"21"`) and every optional field. Build the payload object once, sign it, and send that same object.

### 7.2 Step 1: register an Ed25519 key for the account

Required scope: `keys:create`. Use the **session of the account that will sign** (for example the operator). The account can have several keys.

```json
{
  "context": { "id": "api.account.keys.register", "version": "1.0", "ts": "...", "msgId": "...",
               "developerToken": "c2Et...", "authorization": "Bearer <operator session>" },
  "payload": {
    "type": "ed25519",
    "publicKey": "3f8a1c9d2b7e0f4a6c5d8e9b0a1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c",
    "name": "acme-ops-signing-2026",
    "isDefault": false,
    "isPrimary": false
  }
}
```

201 response. **`response.id` is your `keyId`.**

```json
{
  "context": { "id": "api.account.keys.register", "status": "successful", "...": "..." },
  "response": {
    "id": "0199c0de-2222-7aaa-8bbb-abcdefabcdef",
    "name": "acme-ops-signing-2026",
    "type": "ed25519",
    "publicKeyHex": "3f8a1c9d...a8b9c",
    "address": "<base58 Solana-form address derived from the key>",
    "isPrimary": false, "isDefault": false,
    "did": "did:units:0x3f8a1c9d...",
    "status": "active",
    "wellKnownUrl": null,
    "createdAt": "2026-10-03T10:05:00Z", "updatedAt": "2026-10-03T10:05:00Z"
  }
}
```

Payload rules (closed; exactly one of `publicKey` or `address`):

| field | rule |
|---|---|
| `type` | `ed25519` \| `secp256k1` (only ed25519 can sign envelopes) |
| `publicKey` | hex (64, 66 or 130 chars, optional `0x`) or base58 (32–44). For ed25519, send the **raw 32-byte key as 64 hex chars**. |
| `address` | `0x` + 40 hex (EVM) or base58 32–44 (Solana). A Solana address *is* an ed25519 public key and is rerouted onto the public-key path. |
| `name`, `isPrimary`, `isDefault` | optional. `isPrimary` (per account and key type) is used for proxy-token recipient resolution. The default key cannot be removed. |
| `wellKnownUrl` | optional, at most 2048 characters. `{url}/.well-known/jwks.json` can publish extra accepted keys. |

The call is idempotent per (account, address). Side effect: an asynchronous holdings discovery runs on chains that support the key type, which can auto-import proxy tokens (see the proxy-token docs).

Find existing keys with `/v1/account/keys/search {"type":"ed25519","status":"active","pagination":{"limit":50,"offset":0}}` (returns `{keys:[...], pagination}`) or `/v1/account/keys/get {"id":"<uuid>"}`. Remove one with `/v1/account/keys/remove {"id":"<uuid>"}`. Key rotation (`/v1/account/keys/rotate`) returns **501**, so rotate by registering a new key and removing the old one.

The account's custodial key (created at sign-up) is also a `key_references` row. You cannot sign with it yourself; use `/v1/account/sign` (§7.7).

### 7.3 Step 2: sign the payload

Algorithm:
1. Build the exact `payload` object.
2. `message = UTF-8 bytes of JCS(payload)` (RFC 8785).
3. `sig = Ed25519.sign(privateKey, message)`, which gives 64 bytes.
4. `jws = base64std(sig)`.
5. Send `"signature": {"keyId": "<registered key id>", "jws": "<jws>"}` at the top level of the envelope.

### 7.4 TypeScript (Node 18+, node:crypto, no dependencies)

```ts
import { generateKeyPairSync, createPrivateKey, sign as edSign, KeyObject } from "node:crypto";

/** RFC 8785 JSON Canonicalization Scheme. Correct for UNITS payloads (strings, booleans,
 *  null, safe-range numbers, arrays, objects). JS JSON.stringify number and string
 *  serialisation is the ES6 algorithm that JCS mandates, and the default Array.prototype.sort
 *  orders keys by UTF-16 code units, as JCS requires. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JCS: non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map((v) => canonicalize(v === undefined ? null : v)).join(",") + "]";
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
  }
  throw new Error(`JCS: unsupported type ${typeof value}`);
}

// One-time: generate a key, keep the private key in your KMS/secret store, register the public key.
export function newSigningKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  const publicKeyHex = Buffer.from(jwk.x, "base64url").toString("hex");          // 64 hex chars
  const privatePem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  return { publicKeyHex, privatePem };
}

export function signPayload(payload: unknown, privateKey: KeyObject | string, keyId: string) {
  const key = typeof privateKey === "string" ? createPrivateKey(privateKey) : privateKey;
  const message = Buffer.from(canonicalize(payload), "utf8");
  const jws = edSign(null, message, key).toString("base64");                        // std base64, 88 chars
  return { keyId, jws };
}

// Usage
const payload = { operation: "loan_disbursed", tokenId: loanTokenId,
                  data: { tranche: 1, value: "37800", date: "2026-10-03", txId: "DISB-LOAN-2026-001",
                          newDisbursementAmount: "37800", newPrincipalOutstanding: "37800", newDisbursementStatus: "Full" } };
const signature = signPayload(payload, process.env.UNITS_OPERATOR_SIGNING_KEY_PEM!, process.env.UNITS_OPERATOR_KEY_ID!);
const r = await units("/v1/token/transact", "api.token.transact", payload, { jwt: operatorSession, signature });
// r = { txId, status: "submitted", message, workflowInstanceId }  (HTTP 202) — now poll /v1/transaction/status
```

If you prefer a library, the npm `canonicalize` package (RFC 8785 reference) is a drop-in for `canonicalize()` above.

### 7.5 Python (`cryptography` plus a JCS implementation)

```python
import base64, json, math
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization

def canonicalize(v) -> str:
    """RFC 8785 JCS for UNITS payloads. Integers are exact; non-integral floats are rejected
    (UNITS amounts are strings, so send decimals as strings)."""
    if v is None: return "null"
    if v is True: return "true"
    if v is False: return "false"
    if isinstance(v, str): return json.dumps(v, ensure_ascii=False)
    if isinstance(v, int): return str(v)
    if isinstance(v, float):
        if not math.isfinite(v): raise ValueError("JCS: non-finite number")
        if v.is_integer() and abs(v) < 1e21: return str(int(v))
        raise ValueError("JCS: send non-integral numbers as strings (or use the `jcs` package)")
    if isinstance(v, (list, tuple)): return "[" + ",".join(canonicalize(x) for x in v) + "]"
    if isinstance(v, dict):
        keys = sorted(v.keys(), key=lambda k: k.encode("utf-16-be"))   # JCS: UTF-16 code-unit order
        return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + canonicalize(v[k]) for k in keys) + "}"
    raise TypeError(f"JCS: unsupported type {type(v)}")

# One-time key generation
sk = Ed25519PrivateKey.generate()
public_key_hex = sk.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw).hex()
private_pem = sk.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                               serialization.NoEncryption()).decode()
# -> register public_key_hex via /v1/account/keys/register, keep private_pem in a secret store

def sign_payload(payload: dict, private_pem: str, key_id: str) -> dict:
    key = serialization.load_pem_private_key(private_pem.encode(), password=None)
    sig = key.sign(canonicalize(payload).encode("utf-8"))           # 64 bytes
    return {"keyId": key_id, "jws": base64.b64encode(sig).decode()}

payload = {"operation": "burn", "tokenId": token_id, "value": "10", "reason": "redemption"}
envelope = {"context": ctx("api.token.transact", jwt=session, valueFormat="raw"),
            "payload": payload,
            "signature": sign_payload(payload, private_pem, key_id)}
```

The PyPI `jcs` package (`jcs.canonicalize(obj)` returns bytes) is a full alternative that also handles floats.

### 7.6 bash / openssl (debugging only)

```bash
openssl genpkey -algorithm ed25519 -out ops-ed25519.pem                       # private key (keep secret)
openssl pkey -in ops-ed25519.pem -pubout -outform DER | tail -c 32 | xxd -p -c 64   # 64-hex publicKey to register

# JCS approximation: jq -cS sorts keys and prints compactly; exact for payloads made of ASCII strings,
# booleans, null and integers (which UNITS payloads normally are). Use a real JCS lib otherwise.
jq -cjS '.' payload.json > payload.jcs
openssl pkeyutl -sign -inkey ops-ed25519.pem -rawin -in payload.jcs | base64 | tr -d '\n'   # -> jws (OpenSSL 3.x)
```

### 7.7 Custodial alternative: `/v1/account/sign` (OTP, two-phase)

Use this when the account holder has no key of their own. The instance signs `JCS(payload)` with the account's custodial key after an OTP check. Scope `keys:manage`. Developer token only, because the OTP is the user gate.

This body is **non-standard**. It is not schema-validated, `context` carries `method` and `account_did`, and `username` and `otp` sit at the **top level**:

```json
{
  "context": { "id": "api.account.sign", "version": "1.0", "ts": "...", "msgId": "...",
               "developerToken": "c2Et...",
               "method": "Transfer",
               "account_did": "did:units:0x5126a965c1..." },
  "payload": { "operation": "transfer", "tokenId": "0199a1b2-...", "to": "bob-acme", "value": "2550" },
  "username": "alice@acme.com"
}
```

- **Phase 1** (no `otp`) returns `{"status":"otp_sent","message":"OTP sent. Resubmit with the otp field to complete signing."}`. `username` is required in both phases and must be the email or E.164 phone of the account named by `account_did`; otherwise you get 401 `otp contact does not match account`.
- **Phase 2**: send the same body plus `"otp":"123456"`. Response:

```json
{
  "response": {
    "envelope": {
      "context": { "ulip_version": "v1", "method": "Transfer", "txn_id": "<uuid>", "op_seq": 0,
                   "caller_instance": "", "callee_instance": "", "sent_at": "2026-10-03T10:10:00Z" },
      "payload": { "type_url": "finternet.ulip.v1.Transfer", "value": { "operation": "transfer", "tokenId": "0199a1b2-...", "to": "bob-acme", "value": "2550" } },
      "signature": { "signer_instance": "...", "key_name": "<custodial key name>", "algorithm": "ed25519",
                     "signature": "<std-base64 64-byte sig over JCS(payload)>" }
    },
    "keyId": "<key_references uuid of the custodial key>",
    "method": "Transfer"
  }
}
```

- Then call `/v1/token/transact` with `"signature": {"keyId": response.keyId, "jws": response.envelope.signature.signature}` and the **byte-identical (same values) payload**. The Finternet web app uses exactly this as its "verify to sign" fallback.
- Every transact needs a new OTP round-trip, so this suits interactive end-user flows and not batch backends. Backends should register their own key (§7.2).

---

## 8. Scopes

### 8.1 Catalogue (registry `R__scope_catalogue.sql`, authoritative)

| Entity | Actions | Access level |
|---|---|---|
| `accounts` | view, create, manage | public |
| `tokens` | view, create, **transact**, manage | public |
| `tokenClasses` | view, create, manage | public |
| `tokenClassConfigs` | view, create, manage | public |
| `delegations` | view | public |
| `registry-chains` | view, create, manage | public |
| `registry-wallets` | view, create, manage | public |
| `registry-adapters` | view, create, manage | public |
| `registry-programs` | view, create, manage | public |
| `clients` | view, create, manage | public |
| `keys` | view, create, manage | public |
| `workflows` | view, create, manage | public |
| `internal` | view, create | public |
| `internal` | **manage** | **protected** |
| `scopes` | view | public |
| `terms` | view, create | public |
| `terms` | **manage** | **protected** |
| `*` | (everything) | code-only and protected (superadmin) |

Scope strings look like `entity:action`. Matching (OPA `client_scopes.rego`) supports an exact match, a glob on the `:` segment (`tokens:*`), or `*`. There is no hierarchy: `tokens:manage` does **not** imply `tokens:view` or `tokens:transact`, so request each one. `users:view` and `users:manage` appear in the specs but are **not** in the catalogue. `/v1/users/scopes/*` has no mapping, so it is superadmin-only in practice. The registry catalogue is cached in units-api for `CACHE_TTL`, 86400 s by default.

Read the live catalogue with `/v1/scopes/search {"filters":{},"pagination":{"limit":100,"offset":0}}` (returns `{scopes:[{id, entity, scope, accessLevel, createdAt}]}`) and the api-id-to-scope mapping with `/v1/scopes/apis/search` (returns `{scopeApis:[{id, scopeKey, apiId, createdAt}]}`). Both need `scopes:view`.

### 8.2 Endpoint to scope (integrator-relevant)

| Scope | Api ids / endpoints |
|---|---|
| `accounts:create` | `api.account.create` |
| `accounts:manage` | `api.account.login`, `api.account.refresh`, `api.account.update`, `api.account.otp.generate`, `api.account.otp.verify`, `api.account.pii.decrypt` |
| `accounts:view` | `api.account.get`, `api.account.logout`, `api.address.checkAvailability`, `api.address.resolve` |
| `keys:create` | `api.account.keys.register`, `api.account.keys.create` |
| `keys:view` | `api.account.keys.get`, `api.account.keys.search` |
| `keys:manage` | `api.account.keys.remove`, `api.account.sign`, `api.account.keys.rotate` (501) |
| `tokens:create` | `api.token.mint`, `api.token.add` |
| `tokens:transact` | `api.token.transact` (every operation, including transfer, burn, freeze and update) |
| `tokens:view` | `api.token.get`, `api.token.search`, `api.token.transactions`, `api.transaction.status`, `api.transaction.get`, `api.transaction.search`, `api.transaction.proof`, `api.transaction.proof.leaf`, `api.transaction.proof.verify`, `api.transactions.status` |
| `tokenClasses:create` / `view` / `manage` | `api.tokenclass.register` (and `api.registry.tokenclasses.register`) / `.get`, `.search` / `.update` |
| `tokenClassConfigs:create` / `view` / `manage` | `api.tokenclassconfig.register` / `.get`, `.search` / `.update` |
| `registry-programs:create` / `view` / `manage` | `api.tokenprogram.register` / `.get`, `.search` / `.update` |
| `registry-chains:*`, `registry-wallets:*`, `registry-adapters:*` | `api.registry.chains.*`, `api.registry.wallets.*`, `api.adapter.*` (register = create, update = manage, get/search = view) |
| `delegations:view` | `api.delegations.list`, `api.delegations.check` |
| `workflows:create` / `view` / `manage` | `api.workflow.execute` / `api.workflow.status` / `api.workflow.cancel` |
| `clients:create` | `api.clients.register` (plus the superadmin gate) |
| `clients:view` | `api.clients.get`, `api.clients.list` |
| `clients:manage` | `api.clients.update`, `api.clients.deactivate`, `api.scope-approvals.list` |
| `scopes:view` | `api.scopes.search`, `api.scopes.apis.search` |
| `terms:view` / `create` / `manage` (protected) | `api.terms.get` / `api.terms.accept` / `api.terms.publish` |
| `internal:view` | `api.registry.lookup.address`, `api.instance.capabilities`, `api.internal.transactions.destination_status`, `api.internal.primitives.status` |
| `internal:create` | `api.internal.workflow.register`, `api.internal.transactions.lifecycle_update`, `api.internal.workflow_ops.record` |
| `internal:manage` (protected) | `api.registry.capability.publish` |
| **unmapped**, so a non-superadmin gets 500 `SCOPE_MAPPING_NOT_CONFIGURED` | `api.clients.rotate_secret`, `api.clients.reactivate`, `api.clients.scopes.update`, `api.users.scopes.update`, `api.users.scopes.get`, `api.internal.identities.cache_evict`, `api.internal.delegation.reconcile`, `api.registry.forwarding.get` |

The api id is assigned **server-side per route**. Your `context.id` is only echoed back, but send the matching id for readability and support.

### 8.3 `allowedOperations` (client-level restriction)

This setting narrows a scope to specific request **values**:

```json
"allowedOperations": {
  "tokens:transact": { "payload.operation": ["transfer", "burn"] },
  "tokens:create":   { "payload.tokenClass": ["ACME-PTS", "ACME-CRED"] }
}
```

- The outer key is a scope the client holds. The inner key is a **dot-path into the whole request body** (`payload.operation`, `payload.tokenClass`, `payload.data.currency`, and so on). The value is the list of permitted values, compared as strings.
- Paths are ANDed. Matching is case-insensitive. **If a listed path is missing from the body, the call is denied.** Scopes that aren't listed are unrestricted.
- A denial returns 403 `FORBIDDEN` "client is not allowed to perform this operation". Superadmin clients skip the check.
- `ClientProfile.allowedOperations` echoes the map. One spec shows it flattened as `{scope:[...]}`; trust the nested form.
- Delegations accept the same nested shape (§9.4).

### 8.4 User scopes (per account)

- These are stored as Keycloak client roles on client `units` and appear in claim `resource_access.units.roles`. They are filtered against the catalogue, and globs pass.
- At sign-up every user is seeded with **all public scopes**, so a normal user has every public scope.
- They are enforced only when `enableUserScopeCheck=true`. Then the route's scope must also be in the user's roles, and a failure returns 403 `USER_INSUFFICIENT_SCOPE`. This is environment-dependent. With default seeding the check rarely bites.
- Management: `/v1/users/scopes/get {"account":{"address":"alice.acme"}}` and `/v1/users/scopes/update {"account":{"accountId":"<uuid>"},"scopes":[...]}` (replace semantics; removing scopes forces a logout). Both are unmapped, so they are superadmin-only.
- `CLIENT_INSUFFICIENT_SCOPE` means **your developer token** lacks the scope. `USER_INSUFFICIENT_SCOPE` means **the user** lacks it.

---

## 9. Resource authorization

This is layer 2. It runs after scopes and applies even to superadmin SAs. It is evaluated by OPA (`rbac.rego`) plus Go pre-checks, over the token's `identities` (stored as hashed addresses plus a lowercase role `type`), its labels, and the caller's active delegations.

### 9.1 Who is the caller?
- If a user JWT is present, the caller is that account's hashed address.
- For SA-only calls on `/token/get`, `/token/transact` and `/tokenclass/register` (the "federated" routes), the caller is the **SA owner's** hashed address from the registry bundle. Every other route returns 401 without a user JWT.
- For a third-party OIDC session (when enforced), the caller is the OIDC client's grantee address (§10).

### 9.2 Rules

| Rule | Grants |
|---|---|
| **Owner** (`type: owner` identity on the token) | Everything (view, transact, manage), unless the operation is blocked |
| Any identity on the token (issuer, creator, owner, co-owner, operator, viewer, access) | **view** |
| Flat per-permission identity stamps (`view`\|`access`, `transact`, `manage`) | That permission only. There is **no hierarchy**: manage does not imply transact or view. |
| Active **allow delegation** whose label matches the token, whose permission equals the action, and whose grantor is an identity on the token | That permission |
| Active **deny delegation** with the same (label, permission) | Overrides the allow ("deny wins"). A deny with `allowedOperations` blocks only the matching request values. |
| Class manager operations | Not populated today (effectively unused) |

Action mapping: `/token/get`, `/token/search` and reads map to **view**. `/token/transact` maps to **transact**, except operation `update`, which maps to **manage**. Mint is a separate check: the caller must hold an **issuer** identity on the class if the class has identities. A class whose *stored* identities are `[]` (for example one updated to `[]`) is open for minting by any authenticated user, so don't update identities to `[]`. Registering with `[]` or no identities stamps the caller as owner+issuer instead.

A failure returns 403 `FORBIDDEN` "User not authorized: <reason>", where reason is for example `no_matching_allow_rule` or `operation denied by active deny delegation on label '<label>'`. Mint by a non-issuer returns "user is not authorized to mint tokens for this class". `/token/search` only ever returns tokens where your hash is in `identities` (minus tokens excluded by a deny).

Transaction reads: `/v1/transaction/status|get` require the **initiator** or an identity on the transaction. For `/token/add`, poll with the **owner's** session; the operator gets FORBIDDEN "not authorized to access this transaction". `/v1/transactions/status` (plural, SA-level) is federation/saga status keyed by `txn_id`; integrators should prefer `/v1/transaction/status`.

### 9.3 Delegation labels

| Label | Matches |
|---|---|
| `tokens:id:<token-uuid>` | One token |
| `tokens:tokenclass:<CLASS>` | All of the grantor's tokens of that class |
| `tokens:tokenclass.metadata.status:active` | Any field path on the token or class (`entity:path:value`) |
| `tokens:*` | All of the grantor's tokens |
| `registry-chains:id:<uuid>` (and so on) | Generic resources |

Spaces around `:` are tolerated. Labels always resolve within the **grantor's actual holdings**: you cannot delegate what you don't hold. A transfer to a new owner revokes the old owner's delegations on that token.

### 9.4 Delegation workflows (`POST /v1/workflows/execute`)

Scope `workflows:create` and a user JWT are required. Consent-gated (§11). `grantee_address` is the grantee's **plaintext** address.

**Allow (grant)**. The owner grants `bob-acme` permission to transact one token until year-end, restricted to burn:

```json
{
  "context": { "id": "api.workflow.execute", "version": "1.0", "ts": "...", "msgId": "...",
               "developerToken": "c2Et...", "authorization": "Bearer <alice session>" },
  "payload": {
    "workflow": "delegation-create",
    "action": "allow",
    "data": {
      "grantee_address": "bob-acme",
      "label": "tokens:id:0199a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b",
      "permission": "transact",
      "expires_at": "2026-12-31T23:59:59Z",
      "allowedOperations": { "tokens:transact": { "payload.operation": ["burn"] } }
    }
  }
}
```

202 response:

```json
{ "context": { "status": "accepted", "...": "..." },
  "response": { "delegation_id": "0199d0d0-aaaa-7bbb-8ccc-111122223333", "status": "pending" } }
```

- **Owner path**: the caller is an owner of the labelled resource, or holds an active grant on the exact label and permission, or the resource is cross-instance. The server signs the owner envelope with the caller's custodial key and writes to the registry, and a Restate workflow activates the delegation and stamps an `access` identity onto matching tokens. The status moves from `pending` to `active` within seconds; confirm with `/v1/delegations/list`.
- **Non-owner path** (a request to the owners): the response is `{"delegation_id","delegation_ids":[...],"status":"pending","owners":[<hashes>]}`. Each owner must `approve`. Pending requests expire after about 7 days. If the label has no owner you get 400 "no resource owners found for label"; a duplicate returns 409 "a delegation with this label, permission, and grantee already exists".
- `permission` is one of `view` \| `transact` \| `manage`.
- `allowedOperations` (optional) **must include the derived scope key** (`<label entity>:<permission>`, for example `tokens:transact`). With `transact` it may not list `update` (use `manage` for that).

**Deny** (shadows any allow with the same label and permission):

```json
{ "workflow": "delegation-create", "action": "deny",
  "data": { "grantee_address": "bob-acme", "label": "tokens:tokenclass:USDC", "permission": "transact" } }
```

**Approve / reject** (owner, for a pending request) and **cancel** (requester):

```json
{ "workflow": "delegation-create", "action": "approve", "data": { "delegation_id": "0199d0d0-aaaa-7bbb-8ccc-111122223333" } }
{ "workflow": "delegation-create", "action": "reject",  "data": { "delegation_id": "0199d0d0-aaaa-7bbb-8ccc-111122223333" } }
{ "workflow": "delegation-create", "action": "cancel",  "data": { "delegation_id": "0199d0d0-aaaa-7bbb-8ccc-111122223333" } }
```

**Revoke** (only the grantor, and only when the status is `active`):

```json
{ "workflow": "delegation-revoke", "action": "revoke", "data": { "delegation_id": "0199d0d0-aaaa-7bbb-8ccc-111122223333" } }
```

Errors: 403 "User not authorized: only grantor can revoke", 400 "cannot revoke delegation in 'pending' status", 404 "delegation not found".

Statuses: `pending`, `active`, `rejected`, `cancelled`, `revoked`, `expired`.

Track a workflow with `/v1/workflows/status {"workflowId":"..."}` (scope `workflows:view`) and cancel it with `/v1/workflows/cancel {"workflowId","workflowName"}` (scope `workflows:manage`).

### 9.5 List and check

`/v1/delegations/list` (scope `delegations:view`, user JWT). `filter` is required: `granted_by_me` \| `granted_to_me` \| `pending` (pending means awaiting my approval).

```json
{ "context": { "id": "api.delegations.list", "...": "..." }, "payload": { "filter": "granted_by_me" } }
```
```json
{ "response": { "filter": "granted_by_me", "count": 1, "delegations": [
  { "id": "0199d0d0-aaaa-7bbb-8ccc-111122223333", "grantorAddress": "<hash>", "granteeAddress": "<hash>",
    "label": "tokens:id:0199a1b2-...", "permission": "transact", "ruleType": "allow", "status": "active",
    "expiresAt": "2026-12-31T23:59:59Z", "requestedBy": null, "approvedAt": "2026-10-03T10:20:00Z",
    "revokedAt": null, "createdAt": "2026-10-03T10:19:58Z" } ] } }
```

`/v1/delegations/check {"tokenId":"<uuid>"}` returns the caller's effective permissions on one token:

```json
{ "response": { "tokenId": "0199a1b2-...",
  "permissions": {
    "view":     { "allowed": true,  "source": "delegation", "delegationId": "0199d0d0-...", "labelMatch": "tokens:id:0199a1b2-..." },
    "transact": { "allowed": true,  "source": "delegation", "delegationId": "0199d0d0-...", "labelMatch": "tokens:id:0199a1b2-..." },
    "manage":   { "allowed": false, "source": "none" } },
  "denyRules": [] } }
```

---

## 10. OIDC third-party sessions

"Login with Finternet" lets third-party relying parties (RPs) obtain a user session through the Keycloak `finternet` realm. Third-party clients are onboarded by Finternet. It may not be enabled on every environment; ask Finternet before you build an RP.

When OIDC client-session enforcement is on (environment-dependent) and the JWT's `azp` is neither empty nor `units`:
1. **Route gate**: only these api ids are allowed: `api.token.get`, `api.token.search`, `api.token.transact`, `api.token.transactions`, `api.transaction.status`, `api.transaction.get`, `api.transaction.search`, `api.account.get`. Any other route returns 403 `OIDC_CLIENT_API_NOT_PERMITTED`.
2. **Resource gate**: the effective subject becomes the OIDC client's registry **grantee address**. It never holds an owner identity, so access exists only through label delegations (user to client) materialised at consent. `api.account.get` returns the user's own masked profile.
3. **Fail closed**: an unknown `azp`, an inactive client, or a registry error leaves an empty grantee, so the session can touch no tokens.

Integrators building an RP should design for the enforced mode.

---

## 11. Terms and consent

- Documents: `terms_of_use` (the default docType) and `privacy_notice`. Versions are integers and content is markdown.
- **`/v1/terms/get`** (scope `terms:view`, developer token only, so it can be shown before sign-up): payload `{"docType":"terms_of_use"}` (optional). Returns `{id, docType, version, versionLabel, content, contentFormat:"markdown", contentHash:"sha256:<hex>", status:"published", requiresReconsent, effectiveFrom, publishedAt}`.
- **`/v1/terms/accept`** (scope `terms:create`, user session): payload `{"versionId":"<id from terms/get>","docType":"terms_of_use"}`. Returns `{docType, version, consentedAt, message:"Consent recorded."}`. If a newer version was published after the user saw it you get **409 CONFLICT**; re-fetch and re-prompt.
- `/v1/terms/publish` needs `terms:manage` (protected, platform admins only).
- `/v1/account/get` returns `consents:[{docType, currentVersion, acceptedVersion, consentRequired}]`. If `consentRequired` is true, prompt the user.
- **Enforcement**: environment-dependent. When consent enforcement is on, the mutating user routes `/v1/token/mint`, `/v1/token/transact`, `/v1/account/update`, `/v1/workflows/execute` and `/v1/workflows/cancel` return **403 `TERMS_CONSENT_REQUIRED`** until the user has accepted the latest version of every tracked document. The outstanding docTypes are logged server-side and not returned, so call `/v1/account/get` to see which ones are outstanding.
- Recommended sign-up sequence: `terms/get` for each docType, show it to the user, run `account/create`, then `terms/accept` for each docType with the new session.

```json
{ "context": { "id": "api.terms.accept", "version": "1.0", "ts": "...", "msgId": "...",
               "developerToken": "c2Et...", "authorization": "Bearer <session>" },
  "payload": { "docType": "terms_of_use", "versionId": "5f3c9a1e-2b4d-4c6e-8a1f-9b0c1d2e3f40" } }
```

---

## 12. Federation

- UNITS is a **federation of instances**. Each account has exactly **one home instance**, and token state lives there. The central **registry** (units-services) holds the routing metadata: registered names (address hash to DID to home), developer clients, scopes and delegations, OIDC clients, and each instance's signed capability document. Instances talk to each other over ULIP (signed Ed25519 envelopes).
- Developer tokens are valid across every instance **of one environment's federation**, because that environment's registry resolves them. They don't carry over between environments (sanctum vs prod), which have separate registries. User sessions are **per instance**: the JWT's `instance_url` claim names the issuing instance's API.
- **Login on the wrong instance**: `/v1/account/login` resolves the contact at the registry. If the account is homed elsewhere you get **409 `FORWARD`**, and the message contains the home instance UUID and its API URL (the structured metadata is not returned in the body). Repeat the login against that API URL. Sign-up always homes the account on the instance that received `/v1/account/create`.
- **Token writes on the wrong instance**: if the sender is homed elsewhere, `/token/transact` returns **409 `CONFLICT`** "sender account is homed on another instance" (this one is not `FORWARD`).
- Transfers to recipients on other instances run as a federation saga (Lock, CreateIncoming, CommitDebit, CommitCredit) resolved through the registry. Track them with `/v1/transactions/status {"txn_id"}`.
- Registry outage: SA auth returns 503 `EXTERNAL_SERVICE_ERROR`, and login resolution fails closed.
- Integrators usually talk to **one** instance (the sandbox or prod). Handle `FORWARD` anyway if your users might have signed up through the web app on another instance.

---

## 13. Environment-dependent checks

Some checks are environment-dependent. Build your integration so it works with all of them on.

| Check | Effect when on |
|---|---|
| Transact signature enforcement | Makes `signature` mandatory on `/token/transact`. Always build signing in. |
| User scope check | Enforces user scopes, failing with 403 `USER_INSUFFICIENT_SCOPE` |
| Consent enforcement | Returns 403 `TERMS_CONSENT_REQUIRED` on mutating user routes |
| OIDC client-session enforcement | Restricts third-party OIDC sessions (§10) |

Other per-environment differences: the fixed OTP `123456` works only on non-prod, and the sandbox runs on a schedule (08:00 to 21:00 IST on weekdays).

---

## 14. Troubleshooting matrix

| Symptom | Likely cause | Fix |
|---|---|---|
| 401 "Developer token is missing or empty" | Token sent in an HTTP header | Put it in `context.developerToken` |
| 401 "invalid developer token" | Wrong or obsolete format (`fnt_`, `dev_pk_`), rotated with no grace, deactivated, or wrong registry | Check that it decodes to `sa-<uuid>:<secret>`; ask the platform team |
| 503 EXTERNAL_SERVICE_ERROR on every call | Registry is down, or the sandbox is outside its hours | Retry later; check the schedule |
| 401 "The JWT is missing, invalid, or expired" | JWT in a header, expired, or logged out | Put `Bearer <jwt>` in `context.authorization`; refresh or re-login |
| 401 on a route that should work SA-only | The controller needs a user (most routes do) | Add a user session |
| 401 SESSION_REVOKED | Refresh token reused (concurrent refresh) | Re-login; single-flight refresh |
| 400 INVALID_INPUT on `/account/create` | `entityType:"Individual"`, digits in the name, uppercase or bad characters in the address, or an extra context key | `PERSONAL`/`BUSINESS`; letters and spaces for the name; `^[a-z0-9._-]+$` for the address |
| 400 INVALID_INPUT "additional property" | An extra key in a closed `context` or `payload` (for example `valueFormat` on `/token/add`, `stepUpToken`, `homeInstance` misuse) | Send only the documented fields |
| 403 CLIENT_INSUFFICIENT_SCOPE | Your developer token lacks the scope | Ask for a scope update |
| 403 USER_INSUFFICIENT_SCOPE | The user lacks the scope (gate on) | Ask the platform team to fix the user scopes |
| 403 FORBIDDEN "client is not allowed to perform this operation" | `allowedOperations` blocked a value, or the path is missing | Adjust the client restriction or the payload |
| 403 FORBIDDEN "client registration currently requires a superadmin" | Interim governance | Ask the platform team, or use the web app's API Access page |
| 403 FORBIDDEN "no_matching_allow_rule" | Not an identity on the token / no delegation, or `identities[]` was passed on mint | Act as the owner or operator; never pass `identities[]` on mint |
| 403 FORBIDDEN on polling `/token/add` | Polling with the operator session | Poll with the owner's session |
| 403 TERMS_CONSENT_REQUIRED | Consent gate on | `/terms/get` then `/terms/accept` |
| 403 OIDC_CLIENT_API_NOT_PERMITTED | Third-party session on a non-allowlisted api | Use a first-party session or an allowlisted api |
| 401 "signature with keyId and jws is required" | Unsigned transact (gate on) | §7 |
| 401 "invalid signature" | Signed a different payload (changed after signing, number vs string, a field missing), used base64url, or JCS mismatch | Sign the exact object you send; use std base64 |
| 401 "signature key does not belong to the authenticated account" | Signed with the operator key while sending the user's JWT, or the reverse | The signer's key must belong to the session account |
| 401 "unsupported signature key type" | Signed with a secp256k1 key | Register an ed25519 key |
| 409 FORWARD on login | Account homed on another instance | Call the API URL in the message |
| 409 CONFLICT "sender account is homed on another instance" | Writing on the wrong instance | Use the home instance |
| 500 SCOPE_MAPPING_NOT_CONFIGURED | Api id unmapped (rotate-secret, reactivate, scopes/update, users/scopes) | Platform team or web app |
