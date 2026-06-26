# Builder API (confidential clients)

Public docs: [docs.pymthouse.com](https://docs.pymthouse.com). Mintlify sources: [pymthouse-docs](https://github.com/eliteprox/pymthouse-docs) (`integration/user-management`, `integration/user-tokens`, Usage API); **Billing API** narrative lives in [pymtdocs](https://github.com/eliteprox/pymtdocs) under `docs/integration/` (`billing.mdx`, `plans.mdx`).

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
- Builder API paths use `/api/v1/apps/{clientId}/...`.
- Internal database IDs are implementation details and are not part of the public API contract.

## OpenAPI

Machine-readable contract and interactive reference:

- `GET /api/v1/openapi.json` — OpenAPI 3.1 document (generated from scanned route handlers + per-route metadata).
- `GET /api/v1/docs` — Scalar API reference UI.

Regenerate the route inventory after adding handlers: `npm run openapi:generate`. CI runs `npm run check:openapi` to fail on metadata drift.

OIDC issuer metadata remains at `{issuer}/.well-known/openid-configuration` (not duplicated in OpenAPI except for a virtual `POST /api/v1/oidc/token` pointer).

### Breaking changes (API cleanup)

The following deprecated routes were **removed**. Use the canonical replacement:

| Removed | Replacement |
| --- | --- |
| `GET /api/v1/auth/validate` | `POST /api/v1/auth/validate` with `{ "key": "pmth_…" }` (`BPP_VALIDATE_V2=1`) |
| `GET` / `POST` / `DELETE /api/v1/subscriptions` | `POST /api/v1/apps/{clientId}/users`, `GET …/users/{externalUserId}/subscription`, `POST …/allowances` |
| `POST /api/v1/apps/{clientId}/usage/signed-tickets` | Kafka `create_signed_ticket` → OpenMeter collector (no HTTP ingest) |
| `GET` / `POST` / `DELETE /api/v1/apps/{clientId}/keys` | Per-user keys: `…/users/{externalUserId}/keys` |
| `…/users/{externalUserId}/credits` | `…/users/{externalUserId}/allowances` |
| Dashboard BFF `POST /api/pymthouse/keys/exchange` (not served by pymthouse) | `POST /api/v1/apps/{clientId}/auth/api-key/signer-session` on the issuer |

M2M secret rotation remains at `POST /api/v1/apps/{clientId}/credentials` (provider session).

## Credential types (do not mix)

| Prefix | Role | RFC usage |
| --- | --- | --- |
| `pmth_<hex>` | Per-app-user **API key** | Bearer credential (`Authorization: Bearer pmth_…`) on API-key exchange routes |
| `pmth_cs_<hex>` | Confidential **M2M client secret** | HTTP Basic with `m2m_…` client id (RFC 6749 §2.3.1) — never the API-key bearer exchange |
| `app_…` / `m2m_…` | Public / confidential OAuth client ids | Path params and token endpoint `client_id` |

Presenting `pmth_cs_*` to `POST …/auth/api-key/token` or `…/auth/api-key/signer-session` returns **`400 invalid_request`** (not `401 invalid_client`).

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

Use either:

```http
Authorization: Bearer <access_token>
```

or confidential **HTTP Basic** auth:

```http
Authorization: Basic base64(client_id:client_secret)
```

**Usage API:** Basic auth (or an authorized provider dashboard session — see [Usage API](#usage-api)) is typical; no extra OAuth scope is required beyond valid credentials for that app.

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

## API key → user JWT (subject token)

`POST /api/v1/apps/{clientId}/auth/api-key/token`

- `Authorization: Bearer pmth_<hex>` (per-app-user API key only).
- Optional JSON body: `{ "scope": "sign:job" }`.
- Returns a short-lived user access JWT suitable as `subject_token` for RFC 8693 signer exchange.

---

## API key → signer session (canonical single call)

`POST /api/v1/apps/{clientId}/auth/api-key/signer-session`

- Same Bearer `pmth_*` authentication as above.
- Returns the canonical **`SignerSession`** envelope: `access_token`, `token_type`, `expires_in`, `scope`, `balanceUsdMicros`, `lifetimeGrantedUsdMicros`, optional `signer_url`, optional `issued_token_type`, optional `correlation_id`.
- Integrator/dashboard facades may expose `POST …/api/pymthouse/keys/exchange`, but that route is external to PymtHouse and not part of this OpenAPI contract.

Integrator facades should pass through this response shape unchanged.

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

### Authorization code (interactive)

1. Redirect the user to `{issuer}/auth` with `response_type=code`, `client_id`, `redirect_uri`, `scope`, `state`.
2. Exchange the code at `{issuer}/token` with `grant_type=authorization_code`, the same `redirect_uri`, and `client_id` + `client_secret` for confidential clients.
3. Request only scopes allowed for that client. **Public clients:** PKCE is required. **Confidential clients:** client authentication is required.

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
external_user_id=<platform-user-id>&
audience=livepeer-remote-signer
```

Response includes `access_token` (user-scoped JWT, `aud=livepeer-remote-signer`), `balanceUsdMicros`, and `lifetimeGrantedUsdMicros`.

Direct signing uses `@pymthouse/builder-sdk/signer/server` — mint a user JWT via Builder API OIDC, forward it to the remote signer DMZ, and sign there directly. The PymtHouse `/api/signer/*` signing proxy is **removed**; only `POST /api/signer/device/exchange` remains for device JWT mint. Use `GET /api/v1/apps/{clientId}/signer/routing` for the DMZ URL and webhook URL.

**Identity:** go-livepeer calls `POST /webhooks/remote-signer` (configured via `-remoteSignerWebhookUrl`) to verify the end-user JWT and receive `auth_id` for metering attribution.

**Usage metering (signer-authoritative, async collector):**

1. **Authoritative event:** go-livepeer remote signer emits `create_signed_ticket` events to Kafka (`livepeer-gateway-events`) with `computed_fee` and `auth_id`.
2. **Collector ingest:** OpenMeter collector consumes Kafka, converts Wei to `network_fee_usd_micros`, and writes CloudEvents to OpenMeter/Konnect.
3. **Async diagnostics:** go-livepeer can still POST monitor events to `POST /api/v1/ingest/events` (alias of internal signed-ticket route) with `Bearer INGEST_SHARED_SECRET`. That endpoint remains diagnostic-only and does not write billing usage.

Retail pricing comes from **OpenMeter plans/rate cards** synced when plans are published (`POST`/`PUT …/plans`), not from bps markup on network cost at sign time.

---

## Usage API

Aggregated request and fee usage for a developer application — read-only, tenant-scoped, for billing dashboards and analytics. It follows the same **`client_id`** path convention as the Builder API.

Totals and `groupBy=user` / `groupBy=pipeline_model` read from OpenMeter meters (`network_fee_usd_micros`, `signed_ticket_count`). The `network_fee_usd_micros` meter SUMs the signer's `computed_fee_usd_micros` per `(client_id, external_user_id)`. **`OPENMETER_URL` is required** — responses include `"source": "openmeter"`. Allowance balance is never read from Postgres.

**Balance (subscription allowance):** `GET /api/v1/apps/{clientId}/usage/balance?externalUserId=...` returns OpenMeter entitlement balance (`balanceUsdMicros`, `hasAccess`, etc.) from the user’s active plan subscription (Starter free tier or paid checkout).

**Starter plan (per app):** Each app has a seeded **Starter** plan (`isStarterDefault`) separate from **Network Price** (discovery-only, not synced to OpenMeter). Starter syncs to OpenMeter with a `network_spend` rate card and included usage from `includedUsdMicros`. Providers edit allowance via `PUT /api/v1/apps/{clientId}/starter-plan` with `{ "includedUsdMicros": "5000000" }` (triggers OpenMeter plan sync). New end users are auto-subscribed to Starter when provisioned (`POST /users`, signer mint, signed-ticket ingest) if they have no existing subscription row.

**Manual allowance top-ups:** `POST /api/v1/apps/{clientId}/users/{externalUserId}/allowances` with `{ "amountUsdMicros": "5000000", "source": "manual" }` (hosted OpenMeter only; additive `createGrant` on top of Starter subscription included usage).

**Endpoint:** `GET /api/v1/apps/{clientId}/usage`

### Identity model

- **`clientId`** in the path is the OAuth `client_id` of the developer app.
- Per-user breakdowns include internal **`endUserId`** (PymtHouse UUID) and the builder’s **`externalUserId`** for correlation.

### Authentication

| Mode | Description |
| --- | --- |
| **Confidential client (recommended)** | `Authorization: Basic base64(client_id:client_secret)` — same credentials as other server-to-server calls |
| **Provider session** | Logged-in app owner, platform admin, or team member with `providerAdmins` access — powers the in-app dashboard |

Requests that fail auth or tenant match receive **`404 Not Found`** (not `401`/`403`) to avoid leaking whether a `client_id` exists.

### Query parameters (all optional)

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `startDate` | ISO 8601 | — | Inclusive lower bound on `usage_records.created_at` |
| `endDate` | ISO 8601 | — | Inclusive upper bound |
| `groupBy` | `none` \| `user` \| `pipeline_model` \| `daily_pipeline` | `none` | `user` adds `byUser`; `pipeline_model` adds `byPipelineModel`; `daily_pipeline` adds `byDailyPipeline` (requires `userId`, OpenMeter DAY windows) |
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
  "${BASE_URL}/api/v1/apps/${CLIENT_ID}/usage"
```

Per-user breakdown:

```bash
curl -sS -u "${CLIENT_ID}:${CLIENT_SECRET}" \
  "${BASE_URL}/api/v1/apps/${CLIENT_ID}/usage?groupBy=user"
```

Date window:

```bash
curl -sS -u "${CLIENT_ID}:${CLIENT_SECRET}" \
  "${BASE_URL}/api/v1/apps/${CLIENT_ID}/usage?startDate=2026-01-01T00:00:00.000Z&endDate=2026-12-31T23:59:59.999Z"
```

Filter by internal user id:

```bash
export USER_ID="internal-app-user-uuid"

curl -sS -u "${CLIENT_ID}:${CLIENT_SECRET}" \
  "${BASE_URL}/api/v1/apps/${CLIENT_ID}/usage?userId=${USER_ID}"
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
2. **No NaaP fetch on signing:** direct DMZ signing does not load dashboard pricing for validation. **`GET /api/v1/pipeline-pricing`** still proxies NaaP for UIs; it uses **`fetchDashboardPricing()`** without an in-process pricing cache.
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

### NaaP catalog and pricing routes

| Endpoint | Description |
| --- | --- |
| `GET /api/v1/pipeline-catalog` | NaaP pipeline catalog (cached 5 min). Used by Plans UI dropdowns. |
| `GET /api/v1/pipeline-pricing?pipeline=...&model=...` | NaaP per-orchestrator pricing rows (proxied each request; no in-process cache). Used for UI estimates. |

### Usage API — pipeline/model grouping

`GET /api/v1/apps/{clientId}/usage` supports:

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
| `GET` | `/api/v1/apps/{clientId}/billing/stripe` | Provider session | Stripe Connect status for the app |
| `POST` | `/api/v1/apps/{clientId}/billing/stripe/connect` | App **owner** or platform admin | Start Stripe Connect OAuth |
| `DELETE` | `/api/v1/apps/{clientId}/billing/stripe` | App **owner** or platform admin | Disconnect Stripe |
| `GET` | `/api/v1/apps/{clientId}/billing/invoices` | Provider session (read) | Tenant-scoped invoice list (DTO mapped from OpenMeter) |
| `POST` | `/api/v1/apps/{clientId}/billing/checkout` | Provider session | End-user checkout via OpenMeter subscription + Stripe Checkout |

**Plan → OpenMeter sync:** Publishing a paid plan (`status: active`) creates/updates an OpenMeter plan keyed `{clientId}:{planId}` with flat subscription fee, included allowance on `network_fee_usd_micros`, and usage rate cards. Plans expose `openmeterPlanId`, `lastSyncedAt`, and `syncError` in the dashboard. Sync requires `OPENMETER_URL` / `OPENMETER_API_KEY`; Stripe Connect is for invoicing/checkout, not for provisioning plans in OpenMeter. Stale `openmeterPlanId` values are recreated automatically when OpenMeter returns plan-not-found.

**Billing API v2 (loosely coupled):**

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/v1/apps/{clientId}/plans?apiVersion=2` | Returns `products[]` (`BillingProduct` DTOs with `sync`, `capabilities[].effectiveRetailRateUsd`) |
| `POST` | `/api/v1/apps/{clientId}/plans/{planId}/sync` | Explicit OpenMeter sync command |
| `GET` | `/api/v1/apps/{clientId}/signer/routing` | Direct DMZ signing + webhook routing config |
| `GET`/`POST` | `/api/v1/apps/{clientId}/users/{externalUserId}/allowances` | Unified grants (source: `trial`, `manual`, `promo`, `plan_adjustment`) |
| `GET` | `/api/v1/apps/{clientId}/users/{externalUserId}/subscription` | End-user subscription read model |

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
  "${BASE_URL}/api/v1/apps/${CLIENT_ID}/usage?groupBy=pipeline_model"
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

**Canonical** app-level network surface for integrators (e.g. NaaP). Each app has exactly one undeletable **Network Price** plan row (`plans.is_network_default = true`) whose **`discovery_excluded_capabilities`** JSON defines what is **not** discoverable. The live NaaP pipeline catalog minus those exclusions is the resolved list in **`capabilities`**. **Custom billing plans** only carry pricing overrides; they do **not** widen or narrow discovery.

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

1. **Start from full catalog** — Every `(pipeline, modelId)` currently in NaaP.
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

**Implementation:** [`src/app/api/v1/apps/[id]/manifest/route.ts`](../src/app/api/v1/apps/[id]/manifest/route.ts), [`src/lib/discovery-allowlist.ts`](../src/lib/discovery-allowlist.ts), [`src/lib/network-default-plan.ts`](../src/lib/network-default-plan.ts), [`src/lib/naap-catalog.ts`](../src/lib/naap-catalog.ts).

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
| `PUT` | `/api/v1/apps/{clientId}/plans` | Provider session only | Update plan (body must include `id`; optional **`capabilities`** replaces entire bundle set). **`is_network_default`** cannot be changed. **`PUT` on the Network Price plan id** returns **`400`** — edit exclusions via **`PUT /manifest`** or the Plans UI. Optional **`discoveryProfileId`** (`null` clears the link). |
| `DELETE` | `/api/v1/apps/{clientId}/plans?planId=...` | Provider session only | Delete plan and its bundles. Deleting the **Network Price** default plan returns **`409`**. |

**`discoveryPolicy`** (optional JSON object on legacy profile-linked plans, aligned with NaaP orchestrator leaderboard plan inputs):

- `topN` — integer 1…1000  
- `sortBy` — `"latency"` \| `"price"` \| `"swapRate"` \| `"avail"`  
- `filters` — `{ gpuRamGbMin?, gpuRamGbMax?, priceMax?, maxAvgLatencyMs?, maxSwapRatio? }` (`maxSwapRatio` 0…1; `gpuRamGbMin` ≤ `gpuRamGbMax` when both set)

**Implementation:** [`src/app/api/v1/apps/[id]/billing/route.ts`](../src/app/api/v1/apps/[id]/billing/route.ts), [`src/app/api/v1/apps/[id]/plans/route.ts`](../src/app/api/v1/apps/[id]/plans/route.ts), [`src/app/api/v1/apps/[id]/manifest/route.ts`](../src/app/api/v1/apps/[id]/manifest/route.ts), [`src/lib/discovery-plans.ts`](../src/lib/discovery-plans.ts), [`src/lib/discovery-profile-resolve.ts`](../src/lib/discovery-profile-resolve.ts), [`src/lib/discovery-allowlist.ts`](../src/lib/discovery-allowlist.ts), [`src/lib/network-default-plan.ts`](../src/lib/network-default-plan.ts), [`src/lib/naap-catalog.ts`](../src/lib/naap-catalog.ts).

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
- [`src/app/api/v1/apps/[id]/usage/route.ts`](../src/app/api/v1/apps/[id]/usage/route.ts)
- [`src/app/api/v1/apps/[id]/billing/route.ts`](../src/app/api/v1/apps/[id]/billing/route.ts)
- [`src/app/api/v1/apps/[id]/plans/route.ts`](../src/app/api/v1/apps/[id]/plans/route.ts)
- [`src/lib/provider-apps.ts`](../src/lib/provider-apps.ts) (`getAuthorizedProviderApp`, `getProviderApp`)
- [`src/db/schema.ts`](../src/db/schema.ts) (`usageRecords`, `usageBillingEvents`, `priceOracleSnapshots`, `appUsers`)

**Billing oracle and catalog**

- [`src/lib/billing-runtime.ts`](../src/lib/billing-runtime.ts) (pipeline/model validation, USD micros)
- [`deploy/collector.yaml`](../deploy/collector.yaml) (Kafka → OpenMeter collector for `create_signed_ticket` events)
- [`src/lib/openmeter/`](../src/lib/openmeter/) (OpenMeter facade: customers, invoices, plans-sync, usage-read)
- [`src/lib/prices/public-exchange-spot.ts`](../src/lib/prices/public-exchange-spot.ts) (Binance/Kraken spot fetch)
- [`src/lib/prices/eth-usd-oracle.ts`](../src/lib/prices/eth-usd-oracle.ts) (ETH/USD oracle with DB cache)
- [`src/lib/naap-catalog.ts`](../src/lib/naap-catalog.ts) (NaaP catalog with TTL cache; pricing fetch is uncached)
- [`src/app/api/v1/prices/eth-usd/route.ts`](../src/app/api/v1/prices/eth-usd/route.ts)
- [`src/app/api/v1/pipeline-catalog/route.ts`](../src/app/api/v1/pipeline-catalog/route.ts)
- [`src/app/api/v1/pipeline-pricing/route.ts`](../src/app/api/v1/pipeline-pricing/route.ts)

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
