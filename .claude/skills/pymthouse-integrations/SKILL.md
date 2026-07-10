---
name: pymthouse-integrations
description: >-
  Guides building and debugging apps that integrate with PymtHouse: Builder API,
  OIDC issuer, public vs M2M clients, scopes, device flow (RFC 8628), RFC 8693
  device approval, and NaaP Option B. Use when working in the pymthouse repo,
  adding OAuth clients, debugging token/device flows, or documenting integrator
  behavior.
---

<!-- Keep in sync with .cursor/skills/pymthouse-integrations/SKILL.md -->

# PymtHouse app integrations

PymtHouse is the **sole OIDC issuer** for integrator apps. External backends talk to it via **Builder API** (`/api/v1/apps/{clientId}/...`) and **OIDC** (`/api/v1/oidc/...`). Read discovery from `{issuer}/.well-known/openid-configuration` in production.

## Canonical docs (source of truth)

| Topic | Path |
| --- | --- |
| Builder product (OIDC issuer, Builder API, Usage API, device + token exchange) | `docs/builder-api.md` || [docs.pymthouse.com](https://docs.pymthouse.com)

## Two clients per interactive app

Each developer app typically has **two** registered OIDC clients:

| Role | `client_id` shape | Secret? | Used for |
| --- | --- | --- | --- |
| **Public** (SDK, browser, RFC 8628 device) | `app_…` | No (`token_endpoint_auth_method: none`) | Device/auth URLs, `client_id` in verification links, subject JWT must show this `client_id` |
| **Confidential** (Builder / M2M) | `m2m_…` | Yes | `Authorization: Basic base64(m2m_id:secret)` on Builder routes and RFC 8693 token exchange |

They are siblings: `developer_apps.oidc_client_id` → public row; `developer_apps.m2m_oidc_client_id` → M2M row.

**Do not** put the M2M id in env vars meant for the public app (e.g. integrators must set **public** `app_…` wherever the device URL’s `client_id` or Builder path `{clientId}` is the public id).

## Scopes and “billing pattern”

- **Public client `allowed_scopes`**: Drives end-user token **claims** and, for programmatic user JWTs, whether the app is treated as **per-user** vs **app-level**: presence of `users:token` in that string maps to per-user billing mode (`src/lib/allowed-scopes.ts` → `billingPatternFromAllowedScopesString`).
- **M2M `allowed_scopes`**: Gates **server** calls: `users:write` (upsert users), `users:token` (call user-token mint + token exchange), optionally `device:approve` (dedicated; `users:token` still accepted for device approval exchange).

**Mint user JWT** (`POST .../users/{externalUserId}/token`): M2M authenticates; **requested scopes for the JWT** (e.g. `sign:job`) are validated against the **public** client’s `allowed_scopes`, not the M2M list (`src/app/api/v1/apps/[id]/users/[externalUserId]/token/route.ts`). M2M must still have `users:token` to call the route.

## Builder API quick reference

- Base: `/api/v1/apps/{clientId}/users` — `{clientId}` is always the **public** `app_…` id in paths.
- Auth: Basic (`m2m_…` + secret) or Bearer (machine token).
- **Upsert user**: `POST .../users` with `externalUserId` (idempotent; use DB upsert to avoid duplicate-key races under concurrency).
- **Mint user access token**: `POST .../users/{externalUserId}/token` with optional `{ "scope": "sign:job" }`. Issued JWT `sub` is **`app_users.id`** (app user row), not necessarily a `users` / `end_users` row by itself.
- **Signer session exchange (canonical)**: `POST /api/v1/apps/{clientId}/oidc/token` — RFC 8693 form body with `subject_token` = user JWT or `pmth_*` API key. Optional M2M Basic auth.
- **Clearinghouse direct signer mint**: M2M `POST /api/v1/oidc/token` with `scope=sign:mint_user_token`, `external_user_id` — see `src/lib/oidc/mint-user-signer-token.ts`. Requires M2M `sign:mint_user_token` (inherited when public client has `sign:job`).
- **Allowances**: `POST .../users/{externalUserId}/allowances`, balance `GET .../usage/balance?externalUserId=...` — OpenMeter entitlements on hosted instance.

## OpenMeter / usage ingest

| Area | File |
| --- | --- |
| **OpenMeter writer (metering)** | Kafka `create_signed_ticket` → `deploy/openmeter-collector/collector.yaml` → Konnect OpenMeter |
| Signer ops (no HTTP proxy) | `src/lib/signer-proxy.ts` — DMZ URL, health/sync only; `POST /api/signer/device/exchange` for JWT mint |
| OpenMeter facade | `src/lib/openmeter/` — `customers.ts` (`ensureOpenMeterCustomer` → `{ id, key }`), `invoices.ts`, `plans-sync.ts`, `usage-read.ts`, `stripe-connect.ts` |
| OpenMeter client + BYO config | `src/lib/openmeter/client-factory.ts`, `src/app/api/v1/apps/[id]/openmeter/route.ts` |
| Usage API OpenMeter reads | `src/lib/openmeter/usage-read.ts` (requires `OPENMETER_URL`) |
| Merchant billing routes | `src/app/api/v1/apps/[id]/billing/*` (Stripe connect, invoices, checkout) |
| Bootstrap meters/features | `npm run openmeter:bootstrap`, `docker-compose.openmeter.yml` |

**Flow:** go-livepeer returns authoritative billing snapshot in `RemotePaymentResponse.usage` → pymthouse proxy records network cost to OpenMeter → strips `usage` from gateway response. Metering is Kafka-only via the OpenMeter collector.

**Retail pricing:** OpenMeter-native plans/rate cards synced on plan publish — not bps markup on network cost in the proxy.

**Identity:** Signing HTTP paths pass the client's Bearer user JWT to go-livepeer; the remote-signer webhook verifies OIDC JWT claims for metering attribution. Apache `mod_authnz_jwt` gates only CLI paths (`/__signer_cli`, dedicated `CLI_PORT`) with `scope=admin`.

## Device flow (RFC 8628) + third-party initiate

1. CLI/SDK: `POST .../oidc/device/auth` with **public** `client_id`; poll `POST .../oidc/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code` and optional RFC 8707 `resource` (issuer URL).
2. Browser: `verification_uri_complete` → PymtHouse may **302** to integrator `initiate_login_uri` with `iss` + `target_link_uri` (must be OP origin + path `/oidc/device` with query params).
3. After login, backend **binds** the pending device grant via **RFC 8693** (not a proprietary `/device/approve` URL): mint user JWT, then `POST {issuer}/token` with token-exchange and `resource=urn:pmth:device_code:<user_code>`. Implementation: `src/lib/oidc/device-token-exchange.ts`.
4. **Account id for the grant** must resolve through **`findAccount`** (`src/lib/oidc/account.ts` — `users` / `end_users`). Device approval exchange maps `subject_token.sub` (app user id) → `end_users` via `findOrCreateAppEndUser` before binding (`device-token-exchange.ts`).

Public client must have **device third-party initiate** enabled where required (`device_third_party_initiate_login`).

## Key implementation files

| Area | File |
| --- | --- |
| M2M auth + resolve public sibling | `src/lib/auth.ts` (`authenticateAppClient`) |
| Device approval token exchange | `src/lib/oidc/device-token-exchange.ts` |
| Programmatic user JWT + refresh | `src/lib/oidc/programmatic-tokens.ts` |
| User-token route (scope checks, `oauthClientId` = public) | `src/app/api/v1/apps/[id]/users/[externalUserId]/token/route.ts` |
| App users upsert | `src/app/api/v1/apps/[id]/users/route.ts` |
| OIDC token route (ordering: device exchange before gateway exchange) | `src/app/api/v1/oidc/[...oidc]/route.ts` |
| Device UI verify | `src/app/api/v1/oidc/device/verify/route.ts` |

## Integrator env (e.g. NaaP) checklist

- `PYMTHOUSE_ISSUER_URL` = full issuer (e.g. `http://localhost:3001/api/v1/oidc`); must match `iss` in redirects.
- `PMTHOUSE_CLIENT_ID` = **public** `app_…`.
- `PMTHOUSE_M2M_CLIENT_ID` + `PMTHOUSE_M2M_CLIENT_SECRET` = confidential client for Builder + token exchange.
- Target link validation uses **issuer origin**, not necessarily `PMTHOUSE_BASE_URL` if that points at NaaP (`apps/web-next/src/lib/pymthouse-device-initiate.ts`).

## Debugging tips

- **400 invalid_scope on user-token mint**: Public client missing requested scope (e.g. `sign:job`); or M2M missing `users:token`.
- **400 programmatic / per_user**: Public client `allowed_scopes` must include `users:token` for programmatic user tokens (`programmatic-tokens.ts`).
- **Device poll “grant request is invalid” after browser success**: Grant `accountId` must be an id `findAccount` can load (`end_users` / `users`), not a raw `app_users.id` alone — see device token exchange mapping above.
- **Tests**: `src/test-env.ts` sets dummy `DATABASE_URL` when unset so `npm test` can import DB modules; integration tests may still need a real DB.

When changing OAuth behavior, update `docs/builder-api.md` in the same PR when integrator contracts change, and align the Mintlify pages under `integration/` in [pymthouse-docs](https://github.com/eliteprox/pymthouse-docs) as needed.
