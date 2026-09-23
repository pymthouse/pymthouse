# Customer-service OIDC client (pymthouse identity)

The [customer-service](https://github.com/pymthouse/customer-service) console
authenticates agents against this host’s OIDC issuer and calls admin billing
APIs with a Bearer token that includes the `admin` scope. The DB role
`users.role = admin` is still required (`getAdminUser`). OIDC Bearers are
accepted only when issued to this reserved RP (`web_customer_service` /
`CS_OIDC_CLIENT_ID`); a developer app that lists `admin` in `allowed_scopes`
cannot call `withAdminGuard` even after a platform admin consents.

This is a **standalone** `oidc_clients` row (not a developer app). There is no
`developer_apps` owner; only platform admins can see or edit it under
`/admin/oidc-clients`. OIDC login for this client goes to `/login/admin`
(bearer token from `npm run bootstrap`), not the public `/login` page.

## Issuer

Production: `https://pymthouse.com/api/v1/oidc`  
Staging: `https://staging.pymthouse.com/api/v1/oidc`  
Local: `{NEXTAUTH_URL}/api/v1/oidc` (e.g. `http://localhost:3001/api/v1/oidc`)

Console callbacks are Vercel env on this project, not source constants:

| Vercel target | `CS_OIDC_BUILTIN_REDIRECT_URIS` | `CS_OIDC_EXCLUDED_REDIRECT_URIS` |
| --- | --- | --- |
| Production | `https://ops.pymthouse.com/api/auth/callback/pymthouse` | `https://opstest.pymthouse.com/api/auth/callback/pymthouse` |
| Preview, branch `staging` | `https://opstest.pymthouse.com/api/auth/callback/pymthouse` | `https://ops.pymthouse.com/api/auth/callback/pymthouse` |

Discovery: `{issuer}/.well-known/openid-configuration`

## Provision via bootstrap

`npm run bootstrap` ensures the reserved confidential web RP:

| Setting | Value |
| --- | --- |
| `client_id` | `web_customer_service` (override with `CS_OIDC_CLIENT_ID`) |
| `token_endpoint_auth_method` | `client_secret_post` |
| `grant_types` | `authorization_code`, `refresh_token` |
| `redirect_uris` | from `CS_OIDC_REDIRECT_URI`, else `{CUSTOMER_SERVICE_URL or NEXT_PUBLIC_CUSTOMER_SERVICE_URL or NEXTAUTH_URL}/api/auth/callback/pymthouse` |
| `allowed_scopes` | `openid profile email admin` |

Later bootstrap runs merge redirect URIs only when `CS_OIDC_REDIRECT_URI`,
`CUSTOMER_SERVICE_URL`, or `NEXT_PUBLIC_CUSTOMER_SERVICE_URL` are set in
pymthouse env. They do **not** merge `NEXTAUTH_URL` on re-run (avoids adding
the issuer origin). The customer-service RP also includes
`CS_OIDC_BUILTIN_REDIRECT_URIS` and drops `CS_OIDC_EXCLUDED_REDIRECT_URIS`
(issuer client load, redirect-origin allowlist, and bootstrap). Leave both
unset locally and on feature-branch previews. They also repair
scopes/grants. The client secret is
written **once** on create (or when the hash is missing) to
`.env.customer-service-oidc` (gitignored, mode 600) — not stdout.
Pass `--rotate-secret` to mint a new secret:

```bash
npm run bootstrap
npm run bootstrap -- --rotate-secret
npm run bootstrap -- admin@example.com --rotate-secret
```

Copy values from `.env.customer-service-oidc` into customer-service server env
(never `NEXT_PUBLIC_*`). Day-to-day redirect edits can also be done on
`/admin/oidc-clients`; bootstrap will not remove extra URIs.

## customer-service env

```bash
PYMTHOUSE_ISSUER=https://pymthouse.com/api/v1/oidc
PYMTHOUSE_API_BASE_URL=https://pymthouse.com
CS_OIDC_CLIENT_ID=web_customer_service
CS_OIDC_CLIENT_SECRET=…
# Local:
# CS_OIDC_REDIRECT_URI=http://localhost:3010/api/auth/callback/pymthouse
# NEXTAUTH_URL=http://localhost:3010
# Extra callbacks (Vercel preview consoles). The ops host for this issuer is
# CS_OIDC_BUILTIN_REDIRECT_URIS on the pymthouse project, not this list.
CS_OIDC_REDIRECT_URI=https://customer-service-git-feat-bootstrap-cs-oidc-client-ecs-vercel.vercel.app/api/auth/callback/pymthouse
# NEXTAUTH_URL is local-only; on Vercel the request host is the origin.
NEXTAUTH_SECRET=…
```

## Admin billing APIs used by CS

All require platform admin (session cookie on this host **or** a first-party
`pmth_` token with `admin` scope **or** a CS-RP OIDC access token with `admin`
scope, plus DB admin role):

| Method | Path |
| --- | --- |
| GET/PATCH | `/api/v1/admin/billing/platform` |
| GET/POST | `/api/v1/admin/billing/owner-tiers` |
| PATCH/DELETE | `/api/v1/admin/billing/owner-tiers/{id}` |
| GET | `/api/v1/admin/billing/owners` |
| GET/PATCH | `/api/v1/admin/billing/owners/{userId}` (GET includes `wallet`) |
| POST | `/api/v1/admin/billing/owners/{userId}/grants` |
| GET | `/api/v1/admin/billing/apps` |
| GET | `/api/v1/admin/billing/apps/{appId}` |
| POST | `/api/v1/admin/billing/apps/{appId}/users/{externalUserId}/grants` |

`GET /owners` accepts `q` (email, name, user id, **app name**, app id, or
**M2M / app-user email or external id**), `status=blocked|overage|attention`,
and `page`/`pageSize`. Results are ordered by current-cycle OpenMeter spend
(same meters as owner detail). Each row includes `ownedApps` (with
`billingMode`), `cycleUsage`, `usageStatus`, and `planKind`. Prepaid credits and
live OpenMeter subscriptions remain on the owner detail `wallet`.

`GET /apps` is app-primary for owner-rollup ops: owner, `billingMode`, active
M2M counts, and `blockedM2mUserCount` when the owner Starter wallet is exhausted.
Search includes M2M email / external id. `status=blocked` is owner-rollup apps
whose M2M users are gated on that empty owner wallet.

Owner-rollup M2M grants return `409 owner_rollup_credit_owner` — credit
`POST /owners/{ownerUserId}/grants` instead, which unblocks every M2M user on
those apps. Merchant (and platform-default self-wallet) users may be credited
on the app-user grants route.

Free Builder `POST …/users/{externalUserId}/allowances` is disabled
(`403 free_grant_admin_only`).
