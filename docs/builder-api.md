# Builder API (confidential clients)

Public docs: [docs.pymthouse.com](https://docs.pymthouse.com). Mintlify sources: [pymthouse-docs](https://github.com/eliteprox/pymthouse-docs) (`integration/user-management`, `integration/user-tokens`, Usage API); **Billing API** narrative lives in [pymtdocs](https://github.com/eliteprox/pymtdocs) under `docs/integration/` (`billing.mdx`, `plans.mdx`).

For first-run **Explorer vs Builder** onboarding (dashboard wizard + curl), see [Onboarding](onboarding.md).

This document defines the official PymtHouse Builder API for confidential OAuth clients. It covers machine authentication, end-user provisioning, and issuance of user-scoped JWTs to your backend.

The API follows OAuth 2.0 and OIDC conventions:
- OAuth 2.0 (RFC 6749) for token acquisition
- Bearer token usage (RFC 6750)
- JWT access tokens (RFC 9068)
- Token exchange for remote signer session flow (RFC 8693)
- Resource indicators (RFC 8707)

For issuer-level OIDC behavior and token endpoint details, see [NaaP OIDC integration](naap-oidc-integration.md).

## Identity model

- `client_id` is the canonical app identifier in Builder API URLs.
- **API surfaces:**
  - **Builder (M2M):** canonical `/api/v1/builder/…` for usage; integrator `/api/v1/apps/{clientId}/…` for users, tokens, billing reads (legacy `/apps/…/usage*` aliases remain M2M-only)
  - **End-user:** `/api/v1/user/usage*` (app from Bearer) or `/api/v1/apps/{clientId}/me/…` (path `{clientId}` must match) — bare `pmth_*` key or end-user/signer JWT
  - **Internal:** PymtHouse dashboard/session under canonical `/api/v1/internal/…` (unpublished from the public Scalar UI)
- OIDC issuer stays at `/api/v1/oidc/*`. Public catalog/health stay under `/api/v1/*` without a product prefix.
- Internal database IDs are implementation details and are not part of the public API contract.

## OpenAPI

Machine-readable contract and interactive reference:

| Surface | Spec | Docs UI |
| --- | --- | --- |
| **Public (Builder + End-user)** | `GET /api/v1/openapi.json` | `GET /api/v1/docs` |
| **Internal (dashboard/session)** | `GET /api/v1/internal/openapi.json` | `GET /api/v1/internal/docs` |

The public document includes M2M integrator routes and end-user `/api/v1/user/usage*` plus `/api/v1/apps/{clientId}/me/usage*`. Internal is available at the paths above but is not linked from `/api/v1/docs`.

Regenerate the route inventory after adding handlers: `npm run openapi:generate`. CI runs `npm run check:openapi` to fail on metadata drift.

OIDC issuer metadata remains at `{issuer}/.well-known/openid-configuration`. Signer session exchange accepts a bare `pmth_*` API key as RFC 8693 `subject_token` on both `POST /api/v1/oidc/token` (app resolved from the credential) and `POST /api/v1/apps/{clientId}/oidc/token` (path-scoped).

### Breaking changes (API cleanup)

The following deprecated routes were **removed**. Use the canonical replacement:

| Removed | Replacement |
| --- | --- |
| `GET /api/v1/auth/validate` | `POST /api/v1/auth/validate` with `{ "key": "pmth_…" }` (`BPP_VALIDATE_V2=1`) |
| `GET` / `POST` / `DELETE /api/v1/subscriptions` | `POST /api/v1/apps/{clientId}/users`, `GET …/users/{externalUserId}/subscription`, `POST …/allowances` |
| `POST /api/v1/apps/{clientId}/usage/signed-tickets` | Kafka `create_signed_ticket` → OpenMeter collector (no HTTP ingest) |
| `GET` / `POST` / `DELETE /api/v1/apps/{clientId}/keys` | Per-user keys: `…/users/{externalUserId}/keys` |
| `…/users/{externalUserId}/credits` | `…/users/{externalUserId}/allowances` |
| Dashboard BFF `POST /api/pymthouse/keys/exchange` (not served by pymthouse) | `POST /api/v1/apps/{clientId}/oidc/token` |
| `POST /api/v1/apps/{clientId}/auth/api-key/signer-session` | `POST /api/v1/apps/{clientId}/oidc/token` (form `subject_token=pmth_*`) |
| `POST /api/v1/apps/{clientId}/auth/api-key/token` | `POST /api/v1/apps/{clientId}/oidc/token` or M2M `…/users/{externalUserId}/token` |

M2M secret rotation remains at `POST /api/v1/apps/{clientId}/credentials` (provider session).

## Credential types (do not mix)

| Prefix | Role | RFC usage |
| --- | --- | --- |
| Stored API key (`pmth_<hex>`) | Per-app-user **API key** (hashed at rest) | Personal mint returns bare `pmth_*`; Builder mint returns composite presentation of the same secret |
| `app_<24hex>_<secret>` | **Presented** Builder API key (issuance + remote-signer Bearer) | Same secret as the stored key; `app_*` segment routes pathless exchange / webhooks |
| Client secret (`*_cs_*`) | Confidential client secret | HTTP Basic / `client_secret_post` with the matching client id (RFC 6749 §2.3.1) — never the API-key bearer exchange |
| `app_…` | Public interactive client | Path params and token endpoint `client_id`; `token_endpoint_auth_method=none` (device / SDK; **no** authorization-code redirects) |
| `m2m_…` | Confidential M2M sibling | `client_credentials` only — Builder API / machine tokens |
| `web_…` | Confidential web RP sibling | `authorization_code` + secret + redirects — portal SSO (e.g. Kong Dev Portal); **not** `client_credentials` |

### Client shapes (siblings under one developer app)

| Shape | Client | Secret | Typical grants |
| --- | --- | --- | --- |
| Public interactive | `app_…`, auth method `none` | No | refresh, device (no redirect URIs) |
| M2M backend helper | `m2m_…` | Yes | `client_credentials` |
| Confidential web RP | `web_…` | Yes | auth code + refresh |

Authorization-code (browser / portal) login is registered **only** on the confidential `web_` sibling. The public `app_` client stays secretless for device flow, SDK `client_id`, and API-key routing.

Enable **Confidential web RP** on App profile (same pattern as Confidential M2M backend). Rotate the `web_` secret with `POST /api/v1/apps/{clientId}/credentials?target=web`. Do not put portal SSO credentials on the public SDK client or the M2M helper.

Newly issued **personal** keys are returned as bare `pmth_<hex>`. Builder-minted app-user keys are returned as composite `app_<24hex>_<secret>` (same stored secret):

- Self-serve usage (credential-scoped app): `GET /api/v1/user/usage*` with bare Bearer
- Self-serve usage (path-scoped app): `GET /api/v1/apps/{clientId}/me/usage*` with bare or composite Bearer
- Signer session exchange (RFC 8693): `POST /api/v1/oidc/token` or `POST /api/v1/apps/{clientId}/oidc/token` with `subject_token` = bare `pmth_…` or composite

Composite remains the default presentation for Builder keys so pathless callers (e.g. remote-signer identity webhook) can recover the public client id from a single Bearer. Personal network keys keep a bare `apiKey` for usage, but mint `sdkToken` with the same composite Authorization header.

**Design notes**

- Personal keys stay bare for usage/self-serve; `sdkToken` (livepeer-python-sdk `--token`) embeds the composite `app_*_*` form so pathless signer webhooks can recover `{clientId}`.
- Builder app-user mint returns composite as the presented `apiKey` (and in `sdkToken`) for the same reason.
- Tenancy also lives in the URL for Builder and end-user self-serve routes; the bare secret segment alone is enough there.
- `formatCompositeApiKey` / `splitCompositeApiKey` parse the composite presentation form.

Do not pass M2M client secrets as `subject_token` on the signer session exchange route — use M2M HTTP Basic instead.

### Implementation tasks

- [x] Issue bare `pmth_*` from personal key mint; composite `app_*_*` from Builder app-user key mint.
- [x] Publish `@pymthouse/clearinghouse-identity-webhook` with the matching composite parser (`0.4.2`).
- [x] End-user usage at `/api/v1/user/usage*` (app from credential) and `/api/v1/apps/{clientId}/me/usage*` (path-scoped).

## Authentication

### 1) Obtain machine token (client credentials grant)

Call the OIDC token endpoint:

```http
POST /api/v1/oidc/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&
client_id=<client_id>&
client_secret=<client_secret>&
scope=users:read users:write users:token
```

Or equivalently: `POST {issuer}/token` with the same body (issuer includes `/api/v1/oidc`).

### 2) Calling Builder and Usage routes

**Most Builder integrator routes** (users, tokens, billing reads, discovery) accept either:

```http
Authorization: Bearer <access_token>
```

or confidential **HTTP Basic** auth:

```http
Authorization: Basic base64(client_id:client_secret)
```

**Usage API (Builder + legacy aliases):** confidential-client **HTTP Basic is required** for `/api/v1/builder/apps/…/usage*` and legacy `/api/v1/apps/…/usage*`. Bearer access tokens are not accepted on those paths. Dashboard session usage uses Internal routes (`/api/v1/internal/dashboard/usage`, `/api/v1/internal/me/usage/requests`). No extra OAuth scope is required beyond valid credentials for that app.

---

## User management

**Base path:** `/api/v1/apps/{clientId}/users`

| Method | Path | Required scope | Description |
| --- | --- | --- | --- |
| `GET` | `/api/v1/apps/{clientId}/users` | `users:read` | List provisioned users |
| `POST` | `/api/v1/apps/{clientId}/users` | `users:write` | Create/upsert user (`externalUserId` required) |
| `PUT` | `/api/v1/apps/{clientId}/users` | `users:write` | Update user attributes |
| `DELETE` | `/api/v1/apps/{clientId}/users?externalUserId=...` | `users:write` | Deactivate user (`status: inactive`) |

---

## Signer session exchange (RFC 8693)

Exchange a user access JWT **or** a per-app-user API key (`pmth_*`) for a short-lived signer JWT (`SignerSession`).

| Endpoint | App resolution |
| --- | --- |
| `POST /api/v1/oidc/token` | From the `subject_token` credential (bare `pmth_*` or composite) |
| `POST /api/v1/apps/{clientId}/oidc/token` | Path `{clientId}` must match the credential |

`Content-Type: application/x-www-form-urlencoded`.

| Field | Value |
| --- | --- |
| `grant_type` | `urn:ietf:params:oauth:grant-type:token-exchange` |
| `subject_token` | User access JWT **or** per-app-user API key (`pmth_*`) |
| `subject_token_type` | `urn:ietf:params:oauth:token-type:access_token` |
| `audience` / `resource` | Optional; when provided must match configured signer audience (issuer URL, `SIGNER_TOKEN_AUDIENCE`, or legacy `livepeer-clearinghouse` / `livepeer-remote-signer`) |
| `discovery_url` | Optional override for network discovery (defaults to `{signer_url}/discover-orchestrators`) |
| `caps` | Optional; repeatable capability filters for remote-signer discovery (`caps=pipeline/model`) |

Optional HTTP Basic with the M2M client (`m2m_*` + secret). When omitted, the `subject_token` alone authenticates the exchange. Do not use client secrets (`pmth_cs_*`) as `subject_token`.

Returns the canonical **`SignerSession`** envelope: `access_token`, `token_type`, `expires_in`, `scope`, optional `signer_url`, optional `discovery_url` (defaults to `{signer_url}/discover-orchestrators`; not OIDC metadata), optional `caps` (remote-signer capability filters), optional `issued_token_type`, optional `correlation_id`, and optional PymtHouse extensions `balanceUsdMicros` / `lifetimeGrantedUsdMicros`.

Example (bare API key on the issuer token endpoint — personal key, no `{clientId}` in the URL):

```bash
curl -sS \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
  --data-urlencode "subject_token=pmth_..." \
  --data-urlencode "subject_token_type=urn:ietf:params:oauth:token-type:access_token" \
  "https://your-pymthouse.example/api/v1/oidc/token"
```

Example (API key on the app-scoped route):

```bash
curl -sS \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
  --data-urlencode "subject_token=pmth_..." \
  --data-urlencode "subject_token_type=urn:ietf:params:oauth:token-type:access_token" \
  "https://your-pymthouse.example/api/v1/apps/app_…/oidc/token"
```

Example (user JWT after device flow or M2M user-token mint):

```bash
curl -sS \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
  --data-urlencode "subject_token=USER_JWT" \
  --data-urlencode "subject_token_type=urn:ietf:params:oauth:token-type:access_token" \
  "https://your-pymthouse.example/api/v1/apps/app_…/oidc/token"
```

---

## Issue user-scoped JWT

`POST /api/v1/apps/{clientId}/users/{externalUserId}/token`

- Requires **`users:token`** on the calling client.
- Optional JSON body:

```json
{ "scope": "sign:job" }
```

- Requested scope must be a subset of the **public app client’s** allowed scopes (see product-specific validation in code).
- `admin` is explicitly rejected.
- Default scope when omitted: `sign:job`.

---

## Complete device authorization (RFC 8628 + RFC 8693)

Device login uses the **OIDC token endpoint** `POST {issuer}/token` with `grant_type=urn:ietf:params:oauth:grant-type:token-exchange` — not a separate Builder URL.

### Verification URLs

For device code clients, `/device/auth` responses use:

- **`verification_uri`** — Short URL: `{public origin}/oidc/device`
- **`verification_uri_complete`** — Includes `user_code`, `client_id`, and `iss` so the browser can resume without retyping the code

Unauthenticated users may be redirected once to your registered **`initiate_login_uri`** (third-party initiate login) when the app opts in. The redirect target is loaded **from the database for `client_id`** (open-redirect safe).

**Opt-in:** Enable **Redirect device verification to initiate login URI** and set **Initiate login URI** to your HTTPS endpoint that accepts `iss`, `target_link_uri`, and optional `login_hint`. Validate `iss` against discovery and validate `target_link_uri`. **Option B (NaaP):** after login, mint a user JWT via Builder, then call `POST {issuer}/token` with token exchange and `resource=urn:pmth:device_code:<user_code>` (M2M Basic auth), and show `/oidc/device-approved` instead of sending the browser back to `target_link_uri`.

Treat `initiate_login_uri` as a sensitive redirect (HTTPS in production; HTTP on localhost in dev). Avoid open redirects; use CSRF protection on forms that start login.

### Server-side completion (RFC 8693)

1. Mint a **user-scoped access token** (JWT) via `POST /api/v1/apps/{publicClientId}/users/{externalUserId}/token` (subject token must be issued to the **public** `app_…` client).
2. Call **`POST {issuer}/token`** with confidential **M2M Basic auth** (`m2m_…` client) and form body:

| Field | Value |
| --- | --- |
| `grant_type` | `urn:ietf:params:oauth:grant-type:token-exchange` |
| `subject_token` | JWT from step 1 |
| `subject_token_type` | `urn:ietf:params:oauth:token-type:access_token` |
| `resource` | `urn:pmth:device_code:<user_code>` (same code the CLI received; normalization matches `/oidc/device`) |

- M2M client must allow **`device:approve`** or **`users:token`**.
- **`subject_token`** must be a valid access token issued by this issuer to the **public** `app_…` client (`client_id` / `azp`).
- The **public** OIDC client must have **Redirect device verification to initiate login URI** enabled (`device_third_party_initiate_login`) where required.
- On success, the pending RFC 8628 device grant is bound; the response follows RFC 8693 (`access_token`, `issued_token_type`, etc.).

**End-to-end device login** (high level):

```mermaid
sequenceDiagram
  autonumber
  participant Dev as CLI or device
  participant Tok as Issuer POST /token
  participant Br as Browser
  participant IdP as Your login / session
  participant Bld as Builder API
  participant M2M as Your backend M2M

  Dev->>Tok: Device authorization (RFC 8628)<br/>public app client_id
  Tok-->>Dev: device_code, user_code, verification URIs
  Br->>Tok: User opens verification UI
  Note over Br,IdP: Optional third-party initiate_login to your IdP
  IdP->>M2M: User authenticated
  M2M->>Bld: Mint user JWT for end user<br/>Basic m2m credentials
  Bld-->>M2M: Access JWT (audience = public app_)
  M2M->>Tok: Token exchange RFC 8693<br/>resource = urn:pmth:device_code:...<br/>Basic m2m credentials
  Note right of Tok: Binds pending device grant
  Tok-->>M2M: 200 RFC 8693 response
  Dev->>Tok: Poll with device_code
  Tok-->>Dev: End-user tokens for device session
```

**Token-exchange step only** (what most server integrations implement after minting `USER_JWT`):

```mermaid
sequenceDiagram
  autonumber
  participant M2M as M2M client
  participant Tok as Issuer POST /token

  M2M->>Tok: grant_type=token-exchange
  Note right of M2M: Authorization Basic<br/>client_id:client_secret = m2m_:secret
  Note right of M2M: subject_token = user JWT from Builder<br/>subject_token_type = access_token<br/>resource = urn:pmth:device_code:USERCODE
  Tok-->>M2M: access_token, issued_token_type, ...<br/>device grant bound as side effect
```

Example (after minting `USER_JWT` via Builder):

```bash
ISSUER="https://your-pymthouse.example/api/v1/oidc"
M2M_ID="m2m_..."
M2M_SECRET="pmth_cs_..."
USER_JWT="eyJ..."   # access_token from Builder user-token step (sign:job)

curl -sS -u "${M2M_ID}:${M2M_SECRET}" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
  --data-urlencode "subject_token=${USER_JWT}" \
  --data-urlencode "subject_token_type=urn:ietf:params:oauth:token-type:access_token" \
  --data-urlencode "resource=urn:pmth:device_code:ABCD-EFGH" \
  "${ISSUER}/token"
```

**Implied consent:** For confidential clients with third-party device login enabled, when the user opens the verification UI with a **prefilled** `user_code` from `verification_uri_complete`, the secondary “Authorize” step may be skipped after a successful lookup (the user still authenticated at your site or the OP).

---

## Remote signer session exchange (RFC 8693)

Exchange a short-lived access token for a long-lived opaque remote signer session token (`pmth_*`):

```http
POST {issuer}/token
grant_type=urn:ietf:params:oauth:grant-type:token-exchange
subject_token_type=urn:ietf:params:oauth:token-type:access_token
subject_token=<access_token>
scope=sign:job
```

**Constraints:**

- The authenticated `client_id` must match the `subject_token` audience / client binding (`client_id` or `azp`).
- The `subject_token` must already include `sign:job` scope.

```mermaid
sequenceDiagram
  autonumber
  participant Cli as OAuth client
  participant Tok as Issuer POST /token

  Cli->>Tok: grant_type=token-exchange<br/>subject_token = short-lived access JWT
  Note right of Cli: Same client_id/azp as subject JWT
  Tok-->>Cli: Remote signer session token pmth_*
```

---

## Interactive login and machine access

### Authorization code (interactive / portal SSO)

Use the confidential **`web_…`** sibling (not the public `app_…` client):

1. Redirect the user to `{issuer}/auth` with `response_type=code`, `client_id` (`web_…`), `redirect_uri`, `scope`, `state`.
2. Exchange the code at `{issuer}/token` with `grant_type=authorization_code`, the same `redirect_uri`, and `client_id` + `client_secret`.
3. Request only scopes allowed for that client. Confidential clients must authenticate at the token endpoint.

Public `app_…` clients do not register redirect URIs and do not advertise `authorization_code` — use device flow (RFC 8628) or API keys for interactive / end-user access on the public client.

### Client credentials (machine)

```http
POST {issuer}/token
grant_type=client_credentials
client_id=...
client_secret=...
scope=...
```

---

## Clearinghouse signer mint (Option A)

M2M clients with `sign:mint_user_token` (auto-added when public client has `sign:job`):

```http
POST /api/v1/oidc/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&
client_id=<m2m_client_id>&
client_secret=<m2m_client_secret>&
scope=sign:mint_user_token&
external_user_id=<platform-user-id>
```

Response is a **`SignerSession`** envelope (`access_token` is a short-lived signer JWT). Optional PymtHouse extensions: `balanceUsdMicros`, `lifetimeGrantedUsdMicros`.

For RFC 8693 exchange after minting a user JWT, use `POST /api/v1/apps/{clientId}/oidc/token` (not the global OIDC token endpoint).

Direct signing uses `@pymthouse/builder-sdk/signer/server` — mint a user JWT via Builder API OIDC, forward it to the remote signer DMZ, and sign there directly. The PymtHouse `/api/signer/*` signing proxy is **removed**; only `POST /api/signer/device/exchange` remains for device JWT mint. Use `GET /api/v1/apps/{clientId}/signer/routing` for the DMZ URL and webhook URL.

**Identity:** go-livepeer calls `POST /webhooks/remote-signer` (configured via `-remoteSignerWebhookUrl`) to verify the end-user JWT. The webhook returns `auth_id` (`client_id:usage_subject`) for go-livepeer state persistence. App-owner JWTs keep bare `sub` / `external_user_id` = `{users.id}` with `user_type: "app_owner"`; the webhook maps that to wire `usage_subject` = `owner:{users.id}` so `auth_id` is `app_…:owner:{users.id}` (transport marker for the collector). The collector strips the `owner:` prefix so CloudEvent `subject` / Konnect customer key = bare `{users.id}`.

**Usage metering (signer-authoritative, async collector):**

1. **Authoritative event:** go-livepeer remote signer emits `create_signed_ticket` events to Kafka (`livepeer-gateway-events`) with `computed_fee` and `auth_id` (`client_id:usage_subject`).
2. **Collector ingest:** OpenMeter collector consumes Kafka, parses `auth_id` once (first-colon split), converts Wei to **exact** `network_fee_usd_micros` via `fee_wei * eth_usd / 1e12` (no per-ticket ceil — fractional micros are allowed), and writes normalized CloudEvents to OpenMeter/Konnect:
   - `subject` = compound `auth_id` for M2M end-users; **bare `{users.id}`** when wire `usage_subject` starts with `owner:` (shared owner wallet / Konnect customer key)
   - `data.client_id` = tenant (developer app OAuth `client_id`)
   - `data.usage_subject` / `data.external_user_id` = end user id, or bare `{users.id}` for owners
   - `data.auth_id` retained for compatibility
   - `data.openmeter_customer_key` = billing wallet key (bare owner id or compound end-user key)
   - `data.fee_wei` = Wei from Kafka `computed_fee` as a **number** (required for OpenMeter SUM; authoritative network cost input)
   - `data.eth_usd_price` = ETH/USD oracle rate used for that event’s Wei → USD micros conversion
   - `data.manifest_id` = stream / remote-signer session mid; falls back to Kafka `session_id` (payment StateID) then `request_id` when missing (`"unknown"` only as last resort)
   - `data.billable_secs` = billable duration from the signer as a **number** (required for OpenMeter SUM; prefer this over `pixels` for time analytics across LV2V and BYOC signers)

**Rounding policy:** Exact fractional micros at ingest. Balance gate, Usage API totals, and session (`groupBy=manifest`) fees **ceil once** at the read/session boundary so dense sub-micro ticket streams accumulate into whole micros without overbilling. Invoice line totals round **up to the next cent**.

**Prepaid credits:** App owners share one Konnect customer (bare `{users.id}`) across all owned apps. New owners start on **Owner Sandbox Starter** (`pymthouse_owner_starter`) on the free/sandbox billing profile — included usage via rate-card `discounts.usage`, **hard balance gate** (mint/signer returns `trial_credits_exhausted` at spendable=0; no overage invoice). **Owner Paid tiers** (`pymthouse_owner_paid` / `pymthouse_owner_paid_*`) are admin-managed in `owner_subscription_tiers`: flat monthly fee + included usage + overage. Flow: Add payment method (`POST /api/v1/me/billing/payment-method`) — card attach alone does **not** subscribe; setup success promotes the card to the Stripe/Konnect **default** PM when missing — then explicit Upgrade (`POST /api/v1/me/billing/upgrade-paid` with `{ planKey, confirm: true }`): pins the owners Stripe profile, changes the subscription (new billing cycle), invoices the flat fee, and enables overage `charge_automatically`. Mid-cycle gathering invoices are raised opportunistically on SignerSession mint/reauth when accrued usage hits `invoiceThresholdUsdMicros` (not a cron). Under `owner_rollup`, M2M end-user usage rolls up to that **owner** wallet — session/M2M `…/allowances` credit grants are **not** the shared-owner $5 pool (design.md §1 follow-up). M2M subjects remain `app_…:external_user_id` (per app) on per-app Starter plans (sandbox follow-up). Dashboard owner prepaid strip reads the shared owner wallet; usage and spendable dual-read bare, `owner:`, and compound subjects during transition. Per-app usage pages sum end-user wallets plus the owner row when filtered to the owner.

Retail pricing comes from **OpenMeter plans/rate cards** synced when plans are published (`POST`/`PUT …/plans`), not from bps markup on network cost at sign time.

---

## Usage API

Aggregated request and fee usage for a developer application — read-only, tenant-scoped, for billing dashboards and analytics. It follows the same **`client_id`** path convention as the Builder API.

Totals and `groupBy=user` / `groupBy=pipeline_model` read from billing meters (`network_fee_usd_micros`, `signed_ticket_count`). `groupBy=manifest` reads analytics meters (`network_fee_usd_micros_by_manifest`, `fee_wei`, `billable_secs`) and returns `byManifest` rows with `manifestId`, `networkFeeUsdMicros` (rounded up once per session/read boundary), `networkFeeUsdExact`, `feeWei`, and `billableSecs`. The `network_fee_usd_micros` meter SUMs fees per `(client_id, external_user_id)` where `external_user_id` equals collector-emitted `usage_subject`. **`OPENMETER_URL` is required** — responses include `"source": "openmeter"`. Allowance balance is never read from Postgres.

### End-user Usage API

End users can read **their own** usage with the credential they already hold (no M2M Basic):

| Endpoint | Description |
| --- | --- |
| `GET /api/v1/user/usage` | Aggregates for the authenticated subject; app resolved from the Bearer credential |
| `GET /api/v1/user/usage/balance` | Plan included-usage allowance for that subject |
| `GET /api/v1/user/usage/requests` | Signed-ticket history (`groupBy=session\|request`, `manifestId`, `cursor`, `limit`) |
| `GET /api/v1/apps/{clientId}/me/usage` | Same aggregates with path-scoped app (`{clientId}` must match the credential) |
| `GET /api/v1/apps/{clientId}/me/usage/balance` | Same balance, path-scoped |
| `GET /api/v1/apps/{clientId}/me/usage/requests` | Same request history, path-scoped |

**Auth:** `Authorization: Bearer` with a bare `pmth_*` app-user key, a programmatic user JWT, or a signer JWT (`external_user_id` + `client_id`). Optional composite `app_*_*` is still accepted. On `/apps/{clientId}/me/…`, path `{clientId}` must match the credential’s public app. Identity is taken **only** from the token — do **not** pass `externalUserId` (rejected with 400).

```bash
curl -sS -H "Authorization: Bearer ${API_KEY}" \
  "${BASE_URL}/api/v1/user/usage?groupBy=pipeline_model"

curl -sS -H "Authorization: Bearer ${API_KEY}" \
  "${BASE_URL}/api/v1/user/usage/balance"

curl -sS -H "Authorization: Bearer ${API_KEY}" \
  "${BASE_URL}/api/v1/user/usage/requests?limit=25"

# Path-scoped equivalent when the client id is already known:
curl -sS -H "Authorization: Bearer ${API_KEY}" \
  "${BASE_URL}/api/v1/apps/${CLIENT_ID}/me/usage?groupBy=pipeline_model"
```

### Builder Usage API (M2M)

Canonical Builder paths (**M2M Basic only**):

- `GET /api/v1/builder/apps/{clientId}/usage`
- `GET /api/v1/builder/apps/{clientId}/usage/balance?externalUserId=…`

**Deprecated legacy aliases** (same M2M-only auth; prefer `/builder/…`):

- `GET /api/v1/apps/{clientId}/usage`
- `GET /api/v1/apps/{clientId}/usage/balance?externalUserId=…`

Provider-session usage for the dashboard uses Internal routes (`/api/v1/internal/dashboard/usage`, `/api/v1/internal/me/usage/requests`; legacy `/api/v1/dashboard/usage` and `/api/v1/me/usage/requests` still work).

### Session request history (Internal / Usage dashboard)

**Endpoint:** `GET /api/v1/me/usage/requests` (alias: `GET /api/v1/internal/me/usage/requests`)

Session-authenticated (NextAuth). Default UI view is **sessions** (`groupBy=session`); expand a session for per-request detail, or use `groupBy=request` for the flat ticket list.

| Query | Description |
| --- | --- |
| `groupBy` | `session` (default in UI) — one row per `manifest_id` from analytics meters (`network_fee_usd_micros_by_manifest`, `fee_wei`, `billable_secs`) with session fee rounded up once at the read boundary. `request` — flat CloudEvent list, newest first. |
| `manifestId` | When `groupBy=request`, restrict to one session mid (used when expanding a session). |
| `cursor` | Opaque pagination cursor from a prior response |
| `limit` | Page size (default 25, max 50) |
| `clientId` | Optional public OIDC `app_…` id to restrict to one app (used by `/apps/{id}/usage`). Repeatable / comma-separated `clientIds` for multi-app filters. **Required for `groupBy=session`.** |
| `scope` | `own` (default) — signed-in viewer’s usage subject(s) only. `all` — **platform admins only**; platform-wide history for the selected `clientId`(s) (All Usage tab). Non-admins receive `403`. |

Do **not** pass `externalUserId` — for `scope=own` the server derives subjects from the session (`users.id` plus `app_users.external_user_id` rows matching the session email). Responses include `items`, `nextCursor`, `openMeterConfigured`, `scope`, and `groupBy`.

Per-request fees in the UI are valued exactly from `feeWei × ethUsdPrice` (full sub-micro precision). Session fees are rounded up once at the session/read boundary (same policy as Usage API `groupBy=manifest` totals).

### End-user usage (Bearer subject)

Integrators (e.g. Livepeer Dashboard / `@pymthouse/builder-sdk`) mint a user JWT via Builder `POST .../users/{externalUserId}/token`, then call these routes. Subject is forced from the credential — do **not** pass `userId` / `externalUserId` query params (rejected with 400).

**Endpoint:** `GET /api/v1/user/usage` (or `GET /api/v1/apps/{clientId}/me/usage`)

Same OpenMeter usage shape as `GET /api/v1/builder/apps/{clientId}/usage`, always scoped to the Bearer subject. Supports `startDate`, `endDate`, `groupBy` (`none` / `user` / `pipeline_model` / `daily_pipeline` / `manifest`), and `include=retail`.

**Endpoint:** `GET /api/v1/user/usage/balance` (or `GET /api/v1/apps/{clientId}/me/usage/balance`)

Plan included-usage allowance for the Bearer subject (`balanceUsdMicros` / `remainingUsdMicros` = remaining plan discount, `lifetimeGrantedUsdMicros` = included total for the cycle, `consumedUsdMicros` = granted − remaining, `hasAccess` from spendable). Prepaid credits settle invoices/charges and are not the meter source. Builder M2M equivalent: `GET /api/v1/builder/apps/{clientId}/usage/balance?externalUserId=...` (legacy `/api/v1/apps/.../usage/balance` alias is M2M-only too).

**Endpoint:** `GET /api/v1/user/usage/requests` (or `GET /api/v1/apps/{clientId}/me/usage/requests`)

Lists signed-ticket CloudEvents for the **token subject only** — newest first. Supports `groupBy=session|request` and `manifestId` (same semantics as `/api/v1/me/usage/requests`).

| Query | Description |
| --- | --- |
| `groupBy` | `session` or `request` (default `request`) |
| `manifestId` | When `groupBy=request`, filter to one session mid |
| `cursor` | Opaque pagination cursor from a prior response |
| `limit` | Page size (default 25, max 50) |

Responses include `items`, `nextCursor`, `openMeterConfigured`, `groupBy`, plus `clientId` / `externalUserId` echoed from the credential.

**Balance (Builder M2M):** `GET /api/v1/builder/apps/{clientId}/usage/balance?externalUserId=...` (legacy `/api/v1/apps/...` alias) is the confidential-client equivalent when an end-user JWT is not available.

**Starter plan (per app):** Each app has a seeded **Starter** plan (`isStarterDefault`) for M2M end users, separate from **Network Price** (discovery-only, not synced to OpenMeter). End-user Starter syncs to OpenMeter/Konnect with a `network_spend` rate card for settlement (`credit_then_invoice`) and included usage via `discounts.usage` (amount from `OPENMETER_DEFAULT_STARTER_INCLUDED_USD_MICROS`, default `$5`). **App owners** share one platform wallet on bare `{users.id}`: **Owner Sandbox Starter** (`pymthouse_owner_starter`) first (sandbox profile, hard balance gate), then an **Owner Paid tier** (`pymthouse_owner_paid` / `pymthouse_owner_paid_*`) after payment-method attach and explicit Upgrade (`/api/v1/me/billing/upgrade-paid` with `{ planKey, confirm: true }` — flat fee + included usage + overage). Not a per-app Neon plan row. New end users are auto-subscribed to the app Starter when provisioned (`POST /users`, signer mint, Kafka collector ingest / `openmeter-ensure-customer`).

**Manual allowance top-ups:** `POST /api/v1/apps/{clientId}/users/{externalUserId}/allowances` with `{ "amountUsdMicros": "5000000", "source": "manual" }` (hosted OpenMeter only). On Konnect this is an additive `POST /credits/grants`; on self-hosted it is an additive entitlement `createGrant`. Granting to an end-user who does not exist yet provisions them, so the call clears the same activation gate as `POST …/users` and can return `402 owner_payment_method_required` / `403 end_user_cap_reached`. Owner top-ups are exempt.

**Endpoint:** `GET /api/v1/builder/apps/{clientId}/usage` (legacy alias: `GET /api/v1/apps/{clientId}/usage`)

### Identity model

- **`clientId`** in the path is the OAuth `client_id` of the developer app.
- Per-user breakdowns include internal **`endUserId`** (PymtHouse UUID) and the builder’s **`externalUserId`** for correlation.

### Authentication

| Mode | Description |
| --- | --- |
| **Confidential client (required)** | `Authorization: Basic base64(client_id:client_secret)` — M2M only on Builder/legacy usage paths |
| **Provider session** | Dashboard usage goes through Internal `/api/v1/internal/dashboard/usage` and `/api/v1/internal/me/usage/requests` (not Builder `/apps/…/usage*`) |

Requests that fail auth or tenant match receive **`404 Not Found`** (not `401`/`403`) to avoid leaking whether a `client_id` exists.

### Query parameters (all optional)

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `startDate` | ISO 8601 | — | Inclusive lower bound on `usage_records.created_at` |
| `endDate` | ISO 8601 | — | Inclusive upper bound |
| `groupBy` | `none` \| `user` \| `pipeline_model` \| `daily_pipeline` \| `manifest` | `none` | `user` adds `byUser`; `pipeline_model` adds `byPipelineModel`; `daily_pipeline` adds `byDailyPipeline` (requires `userId`, OpenMeter DAY windows); `manifest` adds `byManifest` (per-stream USD / Wei / billable seconds) |
| `userId` | string | — | Filter to one internal **`usage_records.user_id`** (not `externalUserId`) |
| `gatewayRequestId` | string | — | When set, filters billing events to that gateway request and may include `events` detail |

Invalid dates return `400 Bad Request`. Resolve `externalUserId` → internal id via the Builder user listing or a prior `groupBy=user` response.

### Response shape (`200 OK`)

```json
{
  "clientId": "app_f4c21e7ac5f35d3e91bfad7f",
  "period": {
    "start": "2026-01-01T00:00:00.000Z",
    "end":   "2026-12-31T23:59:59.999Z"
  },
  "totals": {
    "requestCount": 1423,
    "totalFeeWei":  "128750000000000000"
  },
  "byUser": [
    {
      "endUserId":      "5d2b...-uuid",
      "externalUserId": "user-123",
      "requestCount":   42,
      "feeWei":         "3750000000000000"
    }
  ]
}
```

- **`totalFeeWei`** and **`feeWei`** are **decimal strings of wei** (use BigInt-safe parsing; they may exceed `Number.MAX_SAFE_INTEGER`).
- **`byUser`** appears only when `groupBy=user`. Records with no user roll up under `endUserId: "unknown"` and `externalUserId: null`.

### Usage examples

```bash
export BASE_URL="http://localhost:3001"
export CLIENT_ID="app_yourClientId"
export CLIENT_SECRET="pmth_cs_yourSecret"
```

App-level totals:

```bash
curl -sS -u "${CLIENT_ID}:${CLIENT_SECRET}" \
  "${BASE_URL}/api/v1/builder/apps/${CLIENT_ID}/usage"
```

Per-user breakdown:

```bash
curl -sS -u "${CLIENT_ID}:${CLIENT_SECRET}" \
  "${BASE_URL}/api/v1/builder/apps/${CLIENT_ID}/usage?groupBy=user"
```

Date window:

```bash
curl -sS -u "${CLIENT_ID}:${CLIENT_SECRET}" \
  "${BASE_URL}/api/v1/builder/apps/${CLIENT_ID}/usage?startDate=2026-01-01T00:00:00.000Z&endDate=2026-12-31T23:59:59.999Z"
```

Filter by internal user id:

```bash
export USER_ID="internal-app-user-uuid"

curl -sS -u "${CLIENT_ID}:${CLIENT_SECRET}" \
  "${BASE_URL}/api/v1/builder/apps/${CLIENT_ID}/usage?userId=${USER_ID}"
```

**Security:** Do not call the Usage API from a browser with Basic auth; keep secrets server-side.

### Usage data model (`usage_records`)

| Column | Meaning |
| --- | --- |
| `user_id` | Internal `endUserId`; `null` if unattributed |
| `fee` | Wei as decimal string; summed into responses |
| `created_at` | Used for `startDate` / `endDate` filters |

---

## Billing API

Current-cycle **billing snapshot** and **plan CRUD** for a developer app. Full field-by-field reference: Mintlify pages in `pymtdocs/docs/integration/` (see document header).

### Network cost and USD valuation

PymtHouse stores two distinct monetary representations:

- **Wei** — the canonical, exact on-chain unit. All `*Wei` fields are decimal strings.
- **USD micros** — integer strings representing US dollars × 10⁶ (e.g. `1000000` = $1.00). USD values are computed from the ETH/USD oracle at the moment each ticket is signed and are **never recomputed retroactively**.

ETH convenience fields (e.g. `networkFeeEth`, `ownerChargeEth`) are decimal strings derived from the stored wei.

### ETH/USD oracle

The billing oracle uses the livepeer/naap public-exchange pattern (PR #283):

1. Fresh `price_oracle_snapshots` DB cache (5-minute TTL)
2. Live Binance `ETHUSDT` ticker
3. Live Kraken `XETHZUSD` ticker
4. Stale DB cache
5. `ETH_USD_PRICE` environment variable
6. Default fallback `3000`

The oracle source and observation timestamp are stored with each transaction so every USD value can be audited.

**Endpoint:** `GET /api/v1/prices/eth-usd`

Returns `{ ethUsd: { priceUsd, source, observedAt, isFallback } }`.

### App network capability manifest

`GET`/`PUT /api/v1/apps/{clientId}/manifest` expose the app **network capability manifest** for integrators and discovery. **`GET`** returns a fixed allow-all body (`capabilities: []`, `excludedCapabilities: []`, `manifestVersion: "empty"`) without NaaP or plan resolution. **`PUT`** still updates Network-Price exclusions and returns the fully resolved manifest. The manifest is **not** enforced on the signing hot path: direct DMZ signing does not consult it.

The previous process-local in-memory enforcement cache (`manifest_cache_unavailable` / `capability_not_allowed` fail-closed gate) was removed: it failed closed on any process that had not warmed the cache (extra replicas, restarts, or before the off-hot-path warm completed), rejecting otherwise-valid signing requests. Capability scoping is still expressed through the manifest exclusions surfaced on `…/manifest`; billing attribution below is independent of it.

### Trusted pipeline/model attribution

Billable **`usage_billing_events`** rows are created when the signing request resolves to a full pipeline **and** model constraint for billing. Price evidence (`priceWeiPerUnit` / `pixelsPerUnit` and orchestrator address) comes from the **negotiated ticket** on the request (decoded orchestrator info), i.e. the price agreed with the orchestrator by **`python-gateway`** before signing — PymtHouse does **not** call NaaP on this hot path.

1. **Billing constraint:** `pipeline` + `modelId` on the payment request (from the `python-gateway` metadata envelope or a direct API caller), **or** base64 **`capabilities`** (`net.Capabilities`) from which PymtHouse can derive a single pipeline/model (same shape the Go remote signer uses). Billing requires both fields for **`usage_billing_events`**.
2. **No NaaP fetch on signing:** direct DMZ signing does not load dashboard pricing for validation.
3. **Ledger insert:** When a billing constraint is present, PymtHouse records **`usage_billing_events`** using the signed ticket units and a **`pipeline_model_constraint_hash`** over `{ pipeline, modelId, orchAddress, priceWeiPerUnit, pixelsPerUnit }`. **`price_validation_status`** is **`matched`** in that case.
4. **Diagnostics:** **`transactions`** always records metering when the signer succeeds and `feeWei > 0`. If pipeline is present but `modelId` cannot be resolved for billing, **`price_validation_status`** is **`missing_constraint`** and no **`usage_billing_events`** row is written. Signing still succeeds regardless.

**Usage API:** `groupBy=pipeline_model` aggregates from **`usage_billing_events`**, so breakdown rows appear for new traffic that includes `pipeline` + `modelId` (or derivable capabilities) on each payment.

#### Gateway payment metadata contract

`python-gateway` embeds these fields in each `/generate-live-payment` payload when attribution metadata is provided:

```json
{
  "paymentMetadataVersion": "2026-04-usage-attribution-v1",
  "attributionSource": "pymthouse_gateway",
  "gatewayRequestId": "job-or-session-id",
  "pipeline": "text-to-image",
  "modelId": "stabilityai/sdxl"
}
```

PymtHouse uses these fields for attribution and billing-event grouping together with the negotiated ticket price from the request. The go-livepeer remote signer is not required to sign pipeline/model metadata for v1.

### Network catalog route

| Endpoint | Description |
| --- | --- |
| `GET /api/v1/pipeline-catalog` | Network pipeline catalog from remote-signer `GET /discover-orchestrators` (cached 5 min). Used by Plans UI dropdowns. |

### Usage API — pipeline/model grouping

`GET /api/v1/builder/apps/{clientId}/usage` (legacy `/api/v1/apps/{clientId}/usage`) supports:

| Parameter | Description |
| --- | --- |
| `groupBy=pipeline_model` | Aggregate by validated pipeline/model. |
| `groupBy=user` | Aggregate by app user (existing behaviour). |
| `gatewayRequestId=...` | Filter and return per-record billing event detail for a specific gateway job. |

Response totals now include:

| Field | Description |
| --- | --- |
| `totalFeeWei` | Total network fee (existing). |
| `totalFeeEth` | Decimal ETH. |
| `networkFeeUsdMicros` | Transaction-time USD micros (network cost from signer meter). |
| `ownerChargeWei` | Network fee + platform cut. |
| `ownerChargeUsdMicros` | Transaction-time USD micros. |
| `platformFeeWei` | PymtHouse platform cut. |

Retail totals (`endUserBillableUsdMicros`) on Postgres-backed usage rows mirror network cost for diagnostics; **authoritative retail** is computed by OpenMeter from synced plan rate cards and invoices.

### Billing summary

**Endpoint:** `GET /api/v1/apps/{clientId}/billing`

Returns the active plan, subscription period, aggregated usage, per-day timeline, overage, **owner cost breakdown** (network fee + platform fee + total), **retail breakdown** (included allowance consumed vs remaining), and **pipeline/model breakdown** from validated `usage_billing_events`.

#### Plan fields (new)

| Field | Description |
| --- | --- |
| `includedUsdMicros` | Subscription usage allowance in USD micros (e.g. `10000000` = $10.00). |
| `billingCycle` | `"monthly"` (default). |
| `discoveryProfileId` | Optional FK to legacy **`discovery_profiles`** rows. Omitted from billing summary payloads today; may still appear on **`GET .../plans`**. Integrator network capability limits use **`GET .../manifest`**. |

#### Capability bundle fields (legacy)

| Field | Description |
| --- | --- |
| `overageRateUsd` | Plan-level retail USD per network USD-micro (decimal string, e.g. `0.0000015` = 50% markup over pass-through). Synced to OpenMeter usage rate cards. |
| `capabilities[].retailRateUsd` | Per pipeline/model retail override (decimal USD per micro). Creates filtered OpenMeter features + rate cards on plan publish. |

### Merchant billing (OpenMeter behind Builder API)

Tenants never receive `OPENMETER_API_KEY` or direct OpenMeter dashboard access. All billing mutations and reads go through Builder API routes backed by `src/lib/openmeter/*`.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/v1/apps/{clientId}/billing/stripe` | Provider session | Merchant Connect status (`stripeConnectedAccountId`, charges/payouts flags, `applicationFeeBps`, `billingMode`, `endUserCap`, `activation`) + OM profile ids |
| `POST` | `/api/v1/apps/{clientId}/billing/stripe/connect` | App **owner** or platform admin | Start merchant Connect via Account Links: `{ mode?: "account_link" }` (default). Creates Express/Accounts v2 Connected Account if needed, returns Stripe-hosted `{ url }`. `mode: "oauth"` is rejected. |
| `POST` | `/api/v1/apps/{clientId}/billing/stripe/account-link` | App owner/admin | Refresh Stripe Account Link for incomplete onboarding |
| `PATCH` | `/api/v1/apps/{clientId}/billing/stripe` | App owner/admin | Update `progressiveBilling`, `softNegativeUsdMicros`, `invoiceThresholdUsdMicros` (legacy), `applicationFeeBps`, `billingMode`, and/or `endUserCap`. `softNegativeUsdMicros` is an optional app-wide unbilled-debt ceiling while spendable is $0 (mint/signer deny at/above); unset/`0` means no ceiling — overage-eligible users continue past prepaid $0. Per-user opt-in auto top-up (`PATCH …/billing/wallet`) charges the default PM on mint reject or in the soft-negative lead window. Switching to `merchant` requires Connect ready (`charges_enabled` + `details_submitted`). |
| `DELETE` | `/api/v1/apps/{clientId}/billing/stripe` | App **owner** or platform admin | Disconnect merchant Connect (+ clear OM Stripe profile ids) |
| `GET` | `/api/v1/apps/{clientId}/billing/invoices` | Provider session (read) | Tenant-scoped invoice list (DTO mapped from OpenMeter) |
| `POST` | `/api/v1/apps/{clientId}/billing/checkout` | Provider session / M2M | End-user checkout (requires merchant + Connect ready when `ACTIVATION_GATE_MODE` is `enforce_revenue` or `enforce`) |
| `GET` | `/api/v1/apps/{clientId}/billing/tiers` | **M2M Basic only** | List selectable **Owner Paid** tiers (same catalog as session `/api/v1/me/billing/owner-tiers`) |
| `GET` | `/api/v1/apps/{clientId}/billing/subscription` | **M2M Basic only** | Owner-wallet switching status: live Paid key, pending Starter downgrade, payment-method readiness |
| `PUT` | `/api/v1/apps/{clientId}/billing/subscription` | **M2M Basic only** | `{ planKey, confirm: true }` — Starter→Paid or Paid→Paid (idempotent durable op; same codes as session `POST …/me/billing/upgrade-paid`) |
| `DELETE` | `/api/v1/apps/{clientId}/billing/subscription` | **M2M Basic only** | `{ confirm: true }` — schedule Sandbox Starter at end of cycle |
| `DELETE` | `/api/v1/apps/{clientId}/billing/subscription/pending-change` | **M2M Basic only** | `{ confirm: true }` — cancel a pending Starter downgrade |
| `GET`/`POST`/`PATCH`/`DELETE` | `/api/v1/apps/{clientId}/billing/payment-methods` | **M2M Basic only** | List / setup-checkout / set-default / unlink payment methods on the **app owner** wallet. Attach PM ≠ Paid — Upgrade still requires explicit `confirm` |
| `GET` | `/api/v1/apps/{clientId}/users/{externalUserId}/invoices` | M2M / provider | End-user invoice list (`{ items, page, pageSize, totalCount }`) for that app user's OpenMeter customer — not merchant provider-session `/billing/invoices` |
| `GET` | `/api/v1/apps/{clientId}/users/{externalUserId}/invoices/{invoiceId}/hosted-url` | M2M / provider | Stripe `{ hostedInvoiceUrl?, invoicePdf? }` for one invoice scoped to that app user |
| `GET`/`POST` | `/api/v1/apps/{clientId}/users/{externalUserId}/payment-methods` | M2M / provider | List cards / setup-only Checkout for the **end-user** Stripe customer (does not change plan) |
| `POST` | `/api/v1/apps/{clientId}/users/{externalUserId}/subscription/change` | M2M / provider | Switch plan via Konnect change; paid targets may return Connect `checkoutUrl`. A **priced target** is gated by `sell_paid_plans` under `enforce_revenue`/`enforce` and denied with `stripe_connect_required`; free, Starter, and draft targets are never gated, so migrating users off a phased-out paid plan stays possible after switching to `owner_rollup` |

**Owner Paid M2M vs session:** human owners still use verb-style `/api/v1/me/billing/*` (`upgrade-paid`, `downgrade-to-starter`, …) + `/billing/upgrade` UI. Confidential backends use the RESTful `/api/v1/apps/{clientId}/billing/{tiers,subscription,payment-methods}` resources above (M2M Basic; subject = `app.ownerId`). Admin tier catalog CRUD stays on `/api/v1/admin/billing/owner-tiers*` and is not part of Builder M2M.

### App activation gate

Controlled by `ACTIVATION_GATE_MODE` (`off` \| `log` \| `enforce_revenue` \| `enforce`, default `off`). See [`docs/activation-gate.md`](./activation-gate.md).

| Mode | Behaviour |
| --- | --- |
| `off` | Resolve + expose `activation` on `GET /api/v1/apps/{id}`; never deny |
| `log` | Would-deny writes `activation_gate_would_deny` audit rows; still allow |
| `enforce_revenue` | Deny priced plan activate + checkout + priced `subscription/change` targets without merchant Connect readiness |
| `enforce` | Also deny new end-user provisioning when owner wallet is empty or `endUserCap` is reached |

`GET /api/v1/apps/{id}` includes an `activation` object:

```json
{
  "clientId": "app_…",
  "billingMode": "owner_rollup",
  "connectReady": false,
  "canProvisionEndUsers": true,
  "canSellPaidPlans": false,
  "reason": "stripe_connect_required",
  "endUserCap": 25,
  "appUserCount": 3
}
```

Denial responses use RFC 9457 problem details (`Content-Type: application/problem+json`) with machine-readable `code`:

| Condition | Status | `code` |
| --- | --- | --- |
| Owner wallet empty and no payment method on file | `402` | `owner_payment_method_required` |
| Per-app user cap reached | `403` | `end_user_cap_reached` |
| Paid plan / checkout / plan change without Connect | `403` | `stripe_connect_required` |
| Connect started, capabilities not yet granted | `403` | `stripe_connect_pending` |

**Hybrid billing:** OpenMeter meters usage and owns subscriptions. End-user Checkout/invoices use the merchant Connected Account (direct charges + optional `applicationFeeBps`) when `stripeChargesEnabled`. Until then, OM Stripe Checkout remains a fallback unless `connectPaymentsOnly` (or `STRIPE_CONNECT_PAYMENTS_ONLY=1`). With `ACTIVATION_GATE_MODE=enforce_revenue|enforce`, checkout requires `billingMode=merchant` and Connect readiness (`charges_enabled` + `details_submitted`).

**Connect webhooks:** Point a Stripe (Connect) webhook at `POST /webhooks/stripe` with `STRIPE_WEBHOOK_SECRET` and subscribe to `account.updated` so `charges_enabled` / `payouts_enabled` / `details_submitted` stay in sync without waiting for a Payments page refresh.

**Cutover:**
```bash
npm run stripe:connect-cutover -- --client-id app_x          # dry-run
npm run stripe:connect-cutover -- --client-id app_x --apply
npm run stripe:connect-cutover-audit
```

**Stripe Connect by backend (legacy OM install):**

| Backend | Notes |
| --- | --- |
| **Konnect** | OM Stripe app still used for Starter / platform metering until cutover; merchant retail is Connect `acct_…` |
| **Self-hosted** | Same hybrid model |

**Starter billing:** Starter remains on the platform OM Stripe profile until `stripe:connect-cutover` maps merchant-owned `cus_…` rows. Payment methods are not cloned across accounts — cutover logs `needs_checkout`.

**Plan phase-out:** Set `status: "phase_out"` on `PUT …/plans` (optional `replacementPlanId`, `phaseOutAt`). Existing OpenMeter subscriptions keep working; **new** checkout/change targets must be `status: "active"`. `GET …/users/{externalUserId}/subscription` returns `plan.status`, `plan.phaseOutAt`, `plan.replacementPlanId`, and `actionRequired: "choose_new_plan"` when the subscribed plan is phased out or missing locally. Integrators render their own picker and call the change endpoint. `DELETE …/plans` returns **409** while the plan still has active OpenMeter subscribers — migrate first:

```bash
npm run openmeter:migrate-plan-subscribers -- --client-id app_x --from-plan <planId> [--to-plan <planId>] [--timing next_billing_cycle] [--apply]
```

Dry-run is the default; `--to-plan` defaults to `replacementPlanId` then the app Starter plan. Billing consistency audit flags `phase_out_subscribers_past_deadline` when subscribers remain after `phaseOutAt`.

**Plan → OpenMeter sync:** Publishing a paid plan (`status: active`) creates/updates an OpenMeter plan keyed `{clientId}:{planId}` with flat subscription fee, included allowance on `network_fee_usd_micros`, and usage rate cards. Plans expose `openmeterPlanId`, `lastSyncedAt`, and `syncError` in the dashboard. Sync requires `OPENMETER_URL` / `OPENMETER_API_KEY`; Stripe Connect is for invoicing/checkout, not for provisioning plans in OpenMeter. Stale `openmeterPlanId` values are recreated automatically when OpenMeter returns plan-not-found.

**Billing API v2 (loosely coupled):**

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/v1/apps/{clientId}/plans?apiVersion=2` | Returns `products[]` (`BillingProduct` DTOs with `sync`, `capabilities[].effectiveRetailRateUsd`) |
| `POST` | `/api/v1/apps/{clientId}/plans/{planId}/sync` | Explicit OpenMeter sync command |
| `GET` | `/api/v1/apps/{clientId}/signer/routing` | Direct DMZ signing + webhook routing config |
| `GET`/`POST` | `/api/v1/apps/{clientId}/users/{externalUserId}/allowances` | Unified grants (source: `trial`, `manual`, `promo`, `plan_adjustment`) |
| `GET` | `/api/v1/apps/{clientId}/users/{externalUserId}/subscription` | End-user subscription read model (`actionRequired`, `plan` phase-out fields) |
| `POST` | `/api/v1/apps/{clientId}/users/{externalUserId}/subscription/change` | Switch plan (Konnect change + optional checkout) |

**Retail validation:** `GET .../usage?include=retail&groupBy=pipeline_model` estimates `endUserBillableUsdMicros` from active plan retail rates (network meter × configured retail $/micro). Authoritative invoicing remains OpenMeter after plan sync.

**Signer metering:** Production metering is async via Kafka collector (`create_signed_ticket` -> OpenMeter). The signing hot path no longer depends on synchronous OpenMeter writes after cutover.

**Implementation:** [`src/lib/openmeter/plans-sync.ts`](../src/lib/openmeter/plans-sync.ts), [`src/lib/openmeter/customers.ts`](../src/lib/openmeter/customers.ts), [`src/lib/openmeter/invoices.ts`](../src/lib/openmeter/invoices.ts), [`src/lib/openmeter/usage-read.ts`](../src/lib/openmeter/usage-read.ts), [`src/lib/provider-apps.ts`](../src/lib/provider-apps.ts) (`canManageMerchantBilling`).

### Authentication (billing summary)

| Mode | Description |
| --- | --- |
| **Confidential client** | `Authorization: Basic base64(m2m_id:m2m_secret)` — same tenant rules as Usage API |
| **Provider session** | App owner, platform admin, or `providerAdmins` team member |

Failures use **`404 Not Found`** when auth or tenant match fails (same anti-enumeration pattern as Usage API).

### Example (billing summary)

```bash
curl -sS -u "${CLIENT_ID}:${CLIENT_SECRET}" \
  "${BASE_URL}/api/v1/apps/${CLIENT_ID}/billing"
```

### Example (usage groupBy=pipeline_model)

```bash
curl -sS -u "${CLIENT_ID}:${CLIENT_SECRET}" \
  "${BASE_URL}/api/v1/builder/apps/${CLIENT_ID}/usage?groupBy=pipeline_model"
```

### App metadata (integrator read)

**Endpoint:** `GET /api/v1/apps/{clientId}`

| Auth | Description |
| --- | --- |
| **M2M Basic** (path `{clientId}` must match the authenticated public `app_…` id) | Minimal app descriptor for integrators. |
| **Provider session** | Full app record (OIDC client config, domains, edit flags) — unchanged dashboard behavior. |

**M2M response** (subset):

```json
{
  "clientId": "app_…",
  "name": "My App",
  "status": "approved",
  "billingPattern": "app_level",
  "allowedScopes": "sign:job users:read …",
  "links": {
    "manifest": "/api/v1/apps/app_…/manifest"
  }
}
```

Network capability availability is **`GET …/manifest`**, not this route.

**Implementation:** [`src/app/api/v1/apps/[id]/route.ts`](../src/app/api/v1/apps/[id]/route.ts).

### Network capability manifest (integrator pipeline / model caps)

**Canonical** app-level network surface for integrators (e.g. NaaP). Each app has exactly one undeletable **Network Price** plan row (`plans.is_network_default = true`) whose **`discovery_excluded_capabilities`** JSON defines what is **not** discoverable. The live discovery-service catalog minus those exclusions is the resolved list in **`capabilities`**. **Custom billing plans** only carry pricing overrides; they do **not** widen or narrow discovery.

#### Storage (`plans`, network-default row only)

| Field | Shape | Semantics |
| --- | --- | --- |
| **`discovery_excluded_capabilities`** | `{ "capabilities": [ { "pipeline", "modelId" } ] }` | **Subtractive** list against the full catalog. `modelId: "*"` removes every current model for that pipeline. **Null** or empty **`capabilities`** means “nothing excluded” (full catalog discoverable). |

The provider dashboard **Plans** page edits these exclusions on the Network Price section. **`PUT /manifest`** writes the same column (body: **`excludedCapabilities` only**). If new exclusions would hide pipeline/models that a **custom** plan still prices in **`plan_capability_bundles`**, **`PUT` returns `409`** until those bundles are removed or exclusions are relaxed.

#### Fail-open (integrators)

- **`capabilities` empty** → no restriction (fail-open). This includes total exclusion edge cases and failed catalog loads on the integrator side.
- When exclusions are **null/empty**, **`GET`** still loads the catalog and returns the **full** explicit list in **`capabilities`** (not an empty array).
- If the catalog cannot be loaded → **`503`** with `{ "error": "Pipeline catalog unavailable" }`.

#### Resolution (server-side)

1. **Start from full catalog** — Every `(pipeline, modelId)` currently in discovery-service raw.
2. **Subtract exclusions** — Remove any member matching an exclusion row `(P, M)` or pipeline wildcard `(P, "*")`.
3. **Prune** — Drop anything not present in the current catalog.

**`GET`** returns:

```json
{
  "capabilities": [ { "pipeline": "…", "modelId": "…" } ],
  "excludedCapabilities": [ { "pipeline": "…", "modelId": "…" } ],
  "manifestVersion": "a1b2c3…"
}
```

**`manifestVersion`** — SHA-256 prefix (24 hex chars) over sorted `capabilities` + `excludedCapabilities`; use for cache busting.

**`PUT`** (provider session with edit rights) accepts:

```json
{
  "excludedCapabilities": [ { "pipeline": "…", "modelId": "…" } ]
}
```

The response body matches **`GET`** (re-resolved after write).

**Base path:** `/api/v1/apps/{clientId}/manifest`

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/manifest` | **M2M Basic** or provider session | Resolved **`capabilities`**, **`excludedCapabilities`**, **`manifestVersion`**. |
| `PUT` | `/manifest` | Provider session with edit rights | Replace exclusions on the Network Price plan; response same as `GET`. |

**Implementation:** [`src/app/api/v1/apps/[id]/manifest/route.ts`](../src/app/api/v1/apps/[id]/manifest/route.ts), [`src/lib/discovery-allowlist.ts`](../src/lib/discovery-allowlist.ts), [`src/lib/network-default-plan.ts`](../src/lib/network-default-plan.ts), [`src/lib/network-catalog.ts`](../src/lib/network-catalog.ts).

### Discovery profiles (legacy, provider session + M2M read)

Legacy **discovery_profiles** / **`discovery_profile_bundles`** APIs remain for backward compatibility. Prefer **`GET …/manifest`** for new integrator pipeline/model caps. **Billing plans** may still reference **`discoveryProfileId`** until fully migrated.

**Base path:** `/api/v1/apps/{clientId}/discovery-profiles`

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/discovery-profiles` | **M2M Basic** or provider session | List profiles with resolved `policy` and `capabilities[]` (`pipeline`, `modelId`, `discoveryPolicy`) |
| `POST` | `/discovery-profiles` | Provider session only | Create profile: `name` (required), optional `policy`, optional `capabilities[]` with `{ pipeline, modelId, discoveryPolicy }` only |
| `GET` | `/discovery-profiles/{profileId}` | **M2M Basic** or provider session | One profile |
| `PUT` | `/discovery-profiles/{profileId}` | Provider session only | Update `name`, `policy`, and/or replace `capabilities[]` |
| `DELETE` | `/discovery-profiles/{profileId}` | Provider session only | Delete profile; **`409`** if any plan still references it |

**Implementation:** [`src/app/api/v1/apps/[id]/discovery-profiles/route.ts`](../src/app/api/v1/apps/[id]/discovery-profiles/route.ts), [`src/app/api/v1/apps/[id]/discovery-profiles/[profileId]/route.ts`](../src/app/api/v1/apps/[id]/discovery-profiles/[profileId]/route.ts).

### Plans (provider session + M2M read)

**Base path:** `/api/v1/apps/{clientId}/plans`

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/v1/apps/{clientId}/plans` | **M2M Basic** (same pattern as billing: path `{clientId}` = public `app_…` id, credentials must resolve to that app) **or** provider dashboard session | List plans and capability bundles. Each row includes **`isNetworkDefault`** and, on the Network Price plan, **`discoveryExcludedCapabilities`**. Optional legacy **`discoveryProfileId`** and resolved **`discoveryPolicy`** when a profile is linked. |
| `POST` | `/api/v1/apps/{clientId}/plans` | Provider session only | Create **custom** plan (`name` required; reserved names **`Network Price`** / internal default name rejected). **`is_network_default`** cannot be set. Optional legacy **`discoveryProfileId`**. Each **`capabilities[]`** entry is billing-only: `pipeline`, `modelId` (`"*"` allowed), legacy upcharge / max price fields — must reference only **discoverable** rows (catalog minus Network Price exclusions) — **not** `discoveryPolicy`. On publish (`status: active`), syncs to OpenMeter when configured. |
| `PUT` | `/api/v1/apps/{clientId}/plans` | Provider session only | Update plan (body must include `id`; optional **`capabilities`** replaces entire bundle set). **`is_network_default`** cannot be changed. **`PUT` on the Network Price plan id** returns **`400`** — edit exclusions via **`PUT /manifest`** or the Plans UI. Optional **`discoveryProfileId`** (`null` clears the link). Status may be **`draft`**, **`active`**, or **`phase_out`** (optional **`replacementPlanId`**, **`phaseOutAt`**). |
| `DELETE` | `/api/v1/apps/{clientId}/plans?planId=...` | Provider session only | Delete plan and its bundles. Deleting the **Network Price** / **Starter** default plan returns **`409`**. Returns **`409`** while active OpenMeter subscribers remain — phase out + migrate first. |

**`discoveryPolicy`** (optional JSON object on legacy profile-linked plans, aligned with NaaP orchestrator leaderboard plan inputs):

- `topN` — integer 1…1000  
- `sortBy` — `"latency"` \| `"price"` \| `"swapRate"` \| `"avail"`  
- `filters` — `{ gpuRamGbMin?, gpuRamGbMax?, priceMax?, maxAvgLatencyMs?, maxSwapRatio? }` (`maxSwapRatio` 0…1; `gpuRamGbMin` ≤ `gpuRamGbMax` when both set)

**Implementation:** [`src/app/api/v1/apps/[id]/billing/route.ts`](../src/app/api/v1/apps/[id]/billing/route.ts), [`src/app/api/v1/apps/[id]/plans/route.ts`](../src/app/api/v1/apps/[id]/plans/route.ts), [`src/app/api/v1/apps/[id]/manifest/route.ts`](../src/app/api/v1/apps/[id]/manifest/route.ts), [`src/lib/discovery-plans.ts`](../src/lib/discovery-plans.ts), [`src/lib/discovery-profile-resolve.ts`](../src/lib/discovery-profile-resolve.ts), [`src/lib/discovery-allowlist.ts`](../src/lib/discovery-allowlist.ts), [`src/lib/network-default-plan.ts`](../src/lib/network-default-plan.ts), [`src/lib/network-catalog.ts`](../src/lib/network-catalog.ts).

---

## End-to-end integration flows

### Recommended backend flow

1. Backend obtains a machine token via `client_credentials`.
2. Backend creates or upserts the external user via `/users`.
3. Backend issues a user-scoped JWT via `/users/{externalUserId}/token`.
4. Backend returns that JWT to the app session for the same external user.

```mermaid
flowchart LR
  A["1. client_credentials"] --> B["2. POST .../users"]
  B --> C["3. POST .../users/.../token"]
  C --> D["4. Deliver JWT to app session"]
```

For **RFC 8628 device login**, after step 3 call **`POST {issuer}/token`** with RFC 8693 token exchange and `resource=urn:pmth:device_code:<user_code>` as described in [Complete device authorization](#complete-device-authorization-rfc-8628--rfc-8693).

### Example (upsert user)

```bash
CLIENT_ID="app_1234567890abcdef"
CLIENT_SECRET="pmth_cs_..."

curl -sS -u "${CLIENT_ID}:${CLIENT_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{"externalUserId":"user-123","email":"a@example.com","status":"active"}' \
  "https://your-pymthouse.example/api/v1/apps/${CLIENT_ID}/users"
```

---

## Security boundaries and privilege model

- **Tenant boundary** is enforced by matching `client_id` between the route path and the authenticated confidential client (and related checks in code).
- **User token scopes** are bounded by the parent app’s allowed scopes; **`admin`** escalation is blocked on user-token issuance.
- **Usage API and billing summary:** tenant isolation and `404` behavior reduce enumeration of valid apps.
- **Confidential secrets** must remain server-side only.

---

## Implementation checklist

- Register each integrating app as an OIDC client; use discovery metadata rather than hard-coded paths.
- Grant minimum scopes (`users:read`, `users:write`, `users:token`, etc.) per backend.
- Store and rotate client secrets via the app credentials endpoint (`/api/v1/apps/{clientId}/credentials`).
- Map one external user identifier to one Builder API user record.
- Migrate away from legacy `/api/v1/naap/*` routes to OIDC + Builder APIs.
- For usage attribution, populate `usage_records.user_id` when a request maps to a provisioned user; store fees as decimal wei strings.
- For pipeline/model billing, negotiated-ticket evidence is captured through the `/generate-live-payment` flow (or via the `python-gateway` metadata envelope). PymtHouse records `usage_billing_events` after off-path or asynchronous reconciliation of that evidence, while billing totals and plan management remain available via `GET /api/v1/apps/{clientId}/billing` and `/plans` respectively.
- For billing dashboards, call `GET /api/v1/apps/{clientId}/billing` for cycle totals, timeline, overage, and USD breakdown; manage plans via `/plans` from a trusted operator session.
- Use `groupBy=pipeline_model` on the Usage API to get per-pipeline/model ETH and USD breakdown.
- Ensure `(client_id, request_id)` uniqueness for usage rows where applicable.
- Do not attempt to recompute historical USD values using the current oracle rate; use the stored `*UsdMicros` fields.

---

## Implementation reference

**Builder and users**

- [`src/app/api/v1/apps/[id]/users/route.ts`](../src/app/api/v1/apps/[id]/users/route.ts)
- [`src/app/api/v1/apps/[id]/users/[externalUserId]/token/route.ts`](../src/app/api/v1/apps/[id]/users/[externalUserId]/token/route.ts)

**OIDC and token exchange**

- [`src/app/api/v1/oidc/[...oidc]/route.ts`](../src/app/api/v1/oidc/[...oidc]/route.ts)
- [`src/lib/oidc/device-token-exchange.ts`](../src/lib/oidc/device-token-exchange.ts)
- [`src/lib/oidc/gateway-token-exchange.ts`](../src/lib/oidc/gateway-token-exchange.ts)

**Auth and usage**

- [`src/lib/auth.ts`](../src/lib/auth.ts) (`authenticateAppClient`, JWT parsing)
- [`src/app/api/v1/builder/apps/[id]/usage/route.ts`](../src/app/api/v1/builder/apps/[id]/usage/route.ts) (canonical; legacy alias under `apps/[id]/usage`)
- [`src/app/api/v1/apps/[id]/billing/route.ts`](../src/app/api/v1/apps/[id]/billing/route.ts)
- [`src/app/api/v1/apps/[id]/plans/route.ts`](../src/app/api/v1/apps/[id]/plans/route.ts)
- [`src/lib/provider-apps.ts`](../src/lib/provider-apps.ts) (`getAuthorizedProviderApp`, `getProviderApp`)
- [`src/db/schema.ts`](../src/db/schema.ts) (`usageRecords`, `usageBillingEvents`, `priceOracleSnapshots`, `appUsers`)

**Billing oracle and catalog**

- [`src/lib/billing-runtime.ts`](../src/lib/billing-runtime.ts) (pipeline/model validation, USD micros)
- [`deploy/openmeter-collector/collector.yaml`](../deploy/openmeter-collector/collector.yaml) (Kafka → OpenMeter collector for `create_signed_ticket` events)
- [`src/lib/openmeter/`](../src/lib/openmeter/) (OpenMeter facade: customers, invoices, plans-sync, usage-read)
- [`src/lib/prices/public-exchange-spot.ts`](../src/lib/prices/public-exchange-spot.ts) (Binance/Kraken spot fetch)
- [`src/lib/prices/eth-usd-oracle.ts`](../src/lib/prices/eth-usd-oracle.ts) (ETH/USD oracle with DB cache)
- [`src/lib/network-catalog.ts`](../src/lib/network-catalog.ts) (remote-signer discover-orchestrators → pipeline catalog; TTL cache)
- [`src/app/api/v1/prices/eth-usd/route.ts`](../src/app/api/v1/prices/eth-usd/route.ts)
- [`src/app/api/v1/pipeline-catalog/route.ts`](../src/app/api/v1/pipeline-catalog/route.ts)

**Gateway payment metadata (cross-repo)**

- [`../python-gateway/src/livepeer_gateway/payment_metadata.py`](../../python-gateway/src/livepeer_gateway/payment_metadata.py) (canonical metadata envelope)
- [`../python-gateway/src/livepeer_gateway/payments_base.py`](../../python-gateway/src/livepeer_gateway/payments_base.py) (metadata embedded in payment payloads)
- [`../pymthouse-gateway/src/pymthouse_gateway/livepeer/lv2v.py`](../../pymthouse-gateway/src/pymthouse_gateway/livepeer/lv2v.py) (gateway attribution passed to python-gateway)

---

## Design notes

1. **`client_id` as the external app identifier** reduces ambiguity and avoids exposing internal foreign keys.
2. **Builder endpoints** keep internal FK usage server-side for relational integrity.
3. **User JWT issuance** is explicit and scoped — machine tokens do not implicitly inherit end-user privileges.
4. **Basic auth** remains supported for confidential server-to-server clients.
5. **OIDC** uses one registration model for all clients to avoid special-case trust paths.
6. **RFC 8693** preserves auditable token transitions for device binding and remote signer sessions.
7. **Usage totals** use wei strings to avoid JSON precision loss; **404** on usage and billing summary routes limits information leakage.
8. **Billing summary** collapses plan, subscription window, usage, daily timeline, overage, USD cost, and pipeline/model breakdown into one response; raw per-request data remains on the Usage API.
9. **USD micros** are computed once at signing time using the oracle ETH/USD snapshot and stored immutably; historical USD accuracy depends on oracle quality at signing time, not later queries.
10. **Fail-closed billing**: requests without a validated pipeline/model constraint do not generate billable usage events, preventing unattributed usage from accumulating silently.
11. **Attribution source** (`pymthouse_gateway`, `python_gateway`, `direct_api`) is stored with each billing event so reporting can distinguish gateway-originated usage from direct API integrations.

---

## Troubleshooting

### NextAuth session decrypt errors

If logs show repeated `JWT_SESSION_ERROR` or `JWEDecryptionFailed`:

- Keep `NEXTAUTH_SECRET` stable.
- Ensure `.env.local` is not unintentionally overriding `.env`.
- Clear browser cookies for the app origin and sign in again.
