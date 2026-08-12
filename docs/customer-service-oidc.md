# Customer-service OIDC client (pymthouse identity)

The [customer-service](https://github.com/pymthouse/customer-service) console
authenticates agents against this host’s OIDC issuer and calls admin billing
APIs with a Bearer token that includes the `admin` scope. The DB role
`users.role = admin` is still required (`getAdminUser`).

This is a **standalone** `oidc_clients` row (not a developer app). There is no
`developer_apps` owner; only platform admins can see or edit it under
`/admin/oidc-clients`. OIDC login for this client goes to `/login/admin`
(bearer token from `npm run bootstrap`), not the public `/login` page.

## Issuer

Production: `https://pymthouse.com/api/v1/oidc`  
Local: `{NEXTAUTH_URL}/api/v1/oidc` (e.g. `http://localhost:3001/api/v1/oidc`)

Discovery: `{issuer}/.well-known/openid-configuration`

## Provision via bootstrap

`npm run bootstrap` ensures the reserved confidential web RP:

| Setting | Value |
| --- | --- |
| `client_id` | `web_customer_service` (override with `CS_OIDC_CLIENT_ID`) |
| `token_endpoint_auth_method` | `client_secret_post` |
| `grant_types` | `authorization_code`, `refresh_token` |
| `redirect_uris` | from `CS_OIDC_REDIRECT_URI`, else `{CUSTOMER_SERVICE_URL or NEXT_PUBLIC_CUSTOMER_SERVICE_URL or http://localhost:3010}/api/auth/callback/pymthouse` |
| `allowed_scopes` | `openid profile email admin` |

Later bootstrap runs merge redirect URIs only when `CS_OIDC_REDIRECT_URI`,
`CUSTOMER_SERVICE_URL`, or `NEXT_PUBLIC_CUSTOMER_SERVICE_URL` are set in
pymthouse env (customer-service vars are not read from pymthouse by default).
They also repair scopes/grants. The client secret is printed **once** on create (or when the hash is missing).
Pass `--rotate-secret` to mint a new secret:

```bash
npm run bootstrap
npm run bootstrap -- --rotate-secret
npm run bootstrap -- admin@example.com --rotate-secret
```

Copy the printed `CS_OIDC_*` lines into customer-service server env (never
`NEXT_PUBLIC_*`). Day-to-day redirect edits can also be done on
`/admin/oidc-clients`; bootstrap will not remove extra URIs.

## customer-service env

```bash
PYMTHOUSE_ISSUER=https://pymthouse.com/api/v1/oidc
PYMTHOUSE_API_BASE_URL=https://pymthouse.com
CS_OIDC_CLIENT_ID=web_customer_service
CS_OIDC_CLIENT_SECRET=…
CS_OIDC_REDIRECT_URI=http://localhost:3010/api/auth/callback/pymthouse
NEXTAUTH_URL=http://localhost:3010
NEXTAUTH_SECRET=…
```

## Admin billing APIs used by CS

All require platform admin (session cookie on this host **or** Bearer with
`admin` scope + DB admin role):

| Method | Path |
| --- | --- |
| GET/PATCH | `/api/v1/admin/billing/platform` |
| GET/POST | `/api/v1/admin/billing/owner-tiers` |
| PATCH/DELETE | `/api/v1/admin/billing/owner-tiers/{id}` |
| GET | `/api/v1/admin/billing/owners` |
| GET/PATCH | `/api/v1/admin/billing/owners/{userId}` (GET includes `wallet`) |
| POST | `/api/v1/admin/billing/owners/{userId}/grants` |

Free Builder `POST …/users/{externalUserId}/allowances` is disabled
(`403 free_grant_admin_only`).
