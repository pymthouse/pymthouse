# Onboarding (Explorer vs Builder)

First-run flow:

1. **Public preview** at `/start` (no account) — pick Explorer or Builder.
2. **Turnkey** at `/login?callbackUrl=/onboarding?persona=…` — create wallet or sign in.
3. **Resume** on `/onboarding` — mint key (Explorer) or create app (Builder).

Existing accounts use **Sign in** (`/login`) unchanged; completed users land on `/apps`.

Dashboard wizard (post-auth) also lives at `/onboarding`. This document covers the **API path** for the same outcomes.

## Personas

| Persona | Who | App model |
| --- | --- | --- |
| **Explorer** | Individual / try the network | Joins the platform **default app** as an `app_users` row. Usage bills to the user’s own owner wallet (`users.id`) on the platform **Owner Starter** plan — not as an end-user of the admin-owned default app. No OIDC/M2M settings UI. |
| **Builder** | Product / merchant | Creates an owned `developer_apps` row. Full Builder API, plans, users, Stripe. |

The platform default app is flagged `is_platform_default = 1` (or pinned via `PYMTHOUSE_DEFAULT_APP_CLIENT_ID`). Only platform **admins** may edit its config. Its `m2m_…` credentials are **not** for third-party Builder integrations — use your own app.

Bootstrap ensures the default app exists: `npm run bootstrap`.

## Personal Access Token (all developers)

Every developer — Explorer or Builder, with or without owned apps — can mint a **personal network access token** on the platform default app. This does **not** change a Builder’s persona.

```bash
curl -X POST "$BASE/api/v1/network/key" \
  -H "Cookie: …"
```

Response includes `clientId` (public `app_…` only), `apiKey` (`app_<24hex>_<secret>`), and optional `sdkToken` for livepeer-python-sdk.

Do **not** treat the default `clientId` as a target for confidential Builder API backends. The Personal Access Token card on My Apps exposes the same flow in the dashboard.

## Explorer (session)

1. Sign in (dashboard session cookie), optionally after choosing Explorer on `/start`.
2. Optional: set persona.

```bash
curl -X POST "$BASE/api/v1/onboarding" \
  -H "Content-Type: application/json" \
  -H "Cookie: …" \
  -d '{"persona":"explorer"}'
```

3. Mint network key (completes Explorer onboarding on first mint):

```bash
curl -X POST "$BASE/api/v1/network/key" \
  -H "Cookie: …"
```

## Builder (session)

1. Set persona (or soft-skip and resume later):

```bash
curl -X POST "$BASE/api/v1/onboarding" \
  -H "Content-Type: application/json" \
  -H "Cookie: …" \
  -d '{"persona":"builder"}'
```

Soft skip (lands on My Apps with Complete setup):

```bash
curl -X POST "$BASE/api/v1/onboarding" \
  -H "Content-Type: application/json" \
  -H "Cookie: …" \
  -d '{"persona":"builder","softSkip":true}'
```

2. Create app (same as dashboard Create app):

```bash
curl -X POST "$BASE/api/v1/apps" \
  -H "Content-Type: application/json" \
  -H "Cookie: …" \
  -d '{
    "name": "My Product",
    "backendDeviceHelper": true,
    "grantTypes": ["refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
    "allowedScopes": "openid profile offline_access users:token"
  }'
```

3. Mint owner key — upsert yourself as an app user then create a key (see [Builder API](builder-api.md)):

```bash
# externalUserId = your dashboard users.id
curl -X POST "$BASE/api/v1/apps/$CLIENT_ID/users" \
  -H "Content-Type: application/json" \
  -H "Cookie: …" \
  -d "{\"externalUserId\":\"$USER_ID\",\"status\":\"active\"}"

curl -X POST "$BASE/api/v1/apps/$CLIENT_ID/users/$USER_ID/keys" \
  -H "Content-Type: application/json" \
  -H "Cookie: …" \
  -d '{"label":"signing-token"}'
```

Creating an app marks onboarding complete with `persona=builder`. Builders can still call `POST /api/v1/network/key` for a personal network token without changing persona.

## Status

```bash
curl "$BASE/api/v1/onboarding" -H "Cookie: …"
```

Returns `persona`, `onboardingCompletedAt`, `needsOnboarding`, `defaultAppClientId`.

## Related

- [Builder API](builder-api.md) — confidential clients, users, tokens
- Public preview: `/start` → Turnkey → `/onboarding?persona=explorer|builder`
- Dashboard wizard: `/onboarding`
- Personal Access Token: `POST /api/v1/network/key` (My Apps card)
- Existing accounts: `/login` (Sign in)
