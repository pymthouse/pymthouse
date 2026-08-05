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
| **Explorer** | Individual / try the network | Joins the platform **default app** as an `app_users` row. Usage bills to the user’s own owner wallet (`users.id`) on **Owner Sandbox Starter** (then an **Owner Paid** tier after explicit Upgrade) — not as an end-user of the admin-owned default app. No OIDC/M2M settings UI. |
| **Builder** | Product / merchant | Creates an owned `developer_apps` row. Full Builder API, plans, users, Stripe. |

### Plane A progression (owner cost rail)

Default billing is **without Stripe Connect** (`billing_mode=owner_rollup`). The owner pays PymtHouse for network usage; Connect is only for Builders who resell to end users (revenue rail — see [activation-gate.md](activation-gate.md)).

1. **Explorer onboarding** — join **Livepeer Direct** (platform default app) and mint a personal network key.
2. **Owner Sandbox Starter** — free included usage credit on the owner wallet (`users.id`). Hard stop when spendable hits zero (no overage invoice).
3. **Add payment method** — Stripe Checkout setup (`POST /api/v1/me/billing/payment-method`). Attaching a card does **not** subscribe you.
4. **Upgrade** — explicit consent on `/billing` (or `POST /api/v1/me/billing/upgrade-paid` with `{ planKey, confirm: true }`). Pick an admin-defined Owner Paid tier: **flat monthly fee** (charged via Konnect invoice) + included usage (`discounts.usage`) + overage invoices `charge_automatically`. Starts a new billing cycle immediately.

Admin configures tiers at `/admin/billing` (`owner_subscription_tiers`). Keys are `pymthouse_owner_paid` or `pymthouse_owner_paid_<slug>`.

**Builders vs M2M end-users:** A Builder’s own owner wallet follows the same Starter → Upgrade path. End-users of a Builder app under `owner_rollup` ride the **owner’s** cost rail (usage rolls up to the owner Konnect customer). They do **not** each get an Owner Paid plan. Session/M2M allowance grant routes are not the shared-owner credit pool (see follow-ups in PR #352 / design.md §1).

The platform default app is flagged `is_platform_default = 1` (or pinned via `PYMTHOUSE_DEFAULT_APP_CLIENT_ID`). Only platform **admins** may edit its config. Its `m2m_…` credentials are **not** for third-party Builder integrations — use your own app.

Bootstrap ensures the default app exists: `npm run bootstrap`.

## Personal Access Token (all developers)

Every developer — Explorer or Builder, with or without owned apps — can mint a **personal network access token** on the platform default app. This does **not** change a Builder’s persona.

```bash
curl -X POST "$BASE/api/v1/network/key" \
  -H "Cookie: …"
```

Response includes `clientId` (public `app_…` only), bare `apiKey` (`pmth_*`), and optional `sdkToken` for livepeer-python-sdk. Use the key as `Authorization: Bearer` on `/api/v1/user/usage*` (or `/api/v1/apps/{clientId}/me/usage*`).

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
