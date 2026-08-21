---
name: pymthouse-payment-integration
description: >-
  Integrate PymtHouse payments: owner_rollup vs merchant billing, Stripe
  Connect sandbox vs live, wallet top-up, auto-top-up, billing state, and
  end-user cards. Use when wiring Builder billing routes, debugging 402
  mint/signer gates, sbx_eu_ vs eu_ customers, or Merchant Connect.
---

<!-- Keep in sync with .claude/skills/pymthouse-payment-integration/SKILL.md -->

# PymtHouse payment integration

This skill covers **who pays, which Stripe plane, and which Builder routes** an integrator uses. It does not cover minting `sdkToken` (see `pymthouse-sdk-token-streaming`) or OIDC client shapes (see `pymthouse-integrations`).

Canonical contract: `docs/builder-api.md` (Merchant billing + Billing state). Ops for production sandbox Connect: `docs/ops-sandbox-merchant-connect.md`. Manual Connect+charge driver: `docs/e2e-merchant-payments.md`.

## Two rails

| Rail | `billing_mode` | Who pays | OpenMeter customer |
| --- | --- | --- | --- |
| **Cost** (always on) | `owner_rollup` | App owner pays PymtHouse | Owner wallet: bare `{users.id}` |
| **Revenue** (opt-in) | `merchant` | End user pays the Builder via Stripe Connect | Live `eu_{end_users.id}` or sandbox `sbx_eu_{end_users.id}` |

`billing_mode` never answers “who pays PymtHouse.” Owner Sandbox Starter is a hard gate (`overage_not_available` / `trial_credits_exhausted`) until the owner attaches a card and **explicitly** upgrades (`PUT …/billing/subscription` with `{ planKey, confirm: true }`). Attaching a card alone does not subscribe.

Switching to `merchant` requires Connect ready (`charges_enabled` + `details_submitted`). Mode and livemode switches are **mint-forward** (identity cache ≈ 300s + live signer JWT TTL). Already-ingested usage stays on the customer it was billed to.

## Sandbox vs live Merchant Connect

`app_billing_config.stripe_livemode` selects the Stripe **platform**, not a toggle on one `acct_`.

| `stripeLivemode` | Platform key | Webhook | Merchant payer key | Profile |
| --- | --- | --- | --- | --- |
| `false` (default for first owner-rollup Connect) | `STRIPE_SANDBOX_SECRET_KEY` | `POST /webhooks/stripe/sandbox` | `sbx_eu_{end_users.id}` | OpenMeter sandbox / free |
| `true` | `STRIPE_SECRET_KEY` | `POST /webhooks/stripe` | `eu_{end_users.id}` | Custom Invoicing + settlement |

Rules:

- First Connect from `owner_rollup` defaults to **sandbox** unless the owner already PATCHed `stripeLivemode: true`.
- **Cannot** flip `stripeLivemode` while an `acct_` is linked. Disconnect, switch, then Account Link again. Sandbox `acct_` is not promotable.
- Sandbox Checkout / auto-top-up charges use the **sandbox** platform key. Live grants never land on `sbx_eu_…` and sandbox grants never land on `eu_…`.
- Owner Plane A stays on the live Stripe / Konnect app. Sandbox **owner** top-ups on `/webhooks/stripe/sandbox` are ignored (`sandbox_owner_grant`) so test cards cannot mint production owner prepaid.
- Switching Sandbox ↔ Live is a **different customer**. Active prepaid does not follow.

Dashboard: app → Payments. Builder: `GET` / `PATCH /api/v1/apps/{clientId}/billing/stripe` (`stripeLivemode` on both).

## Integrator sequence (merchant app)

Public `app_…` in every path. Authenticate as the app’s **`m2m_…`** sibling (Basic). Using the public or web sibling on wallet routes maps to **404** (`authorizeOwnerWalletM2m`) so existence is not leaked.

```bash
export BASE="https://pymthouse.com"   # or staging / local
export APP="app_…"
export BASIC="$(printf '%s:%s' "$M2M_CLIENT_ID" "$M2M_CLIENT_SECRET" | base64 -w0)"
export EU="your-external-user-id"
```

1. **Provision** the end user (`POST …/users`). Starter auto-subscribes in merchant mode.
2. **Connect** (owner session, not M2M): `POST …/billing/stripe/connect` → Stripe Account Link. Refresh with `…/account-link`.
3. **Sell mode**: `PATCH …/billing/stripe` `{ "billingMode": "merchant" }` once Connect is ready.
4. **Card** (end user): `POST …/users/{eu}/payment-methods` → setup Checkout; or `POST …/billing/wallet/payment-methods` (side-effect: materializes the connected-account `cus_`). `PATCH …/wallet/payment-methods` `{ "ensureDefault": true }`.
5. **Prepaid** (optional): `POST …/billing/wallet/top-up` `{ "amountUsd": "10.00", "externalUserId": "$EU", "successUrl", "cancelUrl" }` → `checkoutUrl`.
6. **Auto-top-up** (optional): `PATCH …/billing/wallet` `{ "externalUserId", "enabled": true, "amountUsd": "10.00" }`. Requires a default card. Fires when live spendable hits $0, **before** soft-negative overage.
7. **Gate**: `GET …/billing/state?externalUserId=$EU` (or `GET …/billing/wallet?externalUserId=$EU`). Branch on `canSpend`, `status`, `reason`.
8. **Collect** (optional): `POST …/billing/collect` `{ "externalUserId": "$EU" }`. `outcome: "queued"` means settlement accepted the raise, not that an invoice exists. Poll `billingState.collection.nextAction`.

Owner-rollup backends skip steps 2–4 for end users. They fund the **owner** wallet (`POST …/billing/wallet/top-up` without `externalUserId`, or session `POST /api/v1/me/billing/payment-method` + Upgrade).

## Spend waterfall and 402s

Spendable is **included usage → prepaid credits → spending buffer / invoice**.

| `billingState.status` | `canSpend` | Meaning |
| --- | --- | --- |
| `active` | `true` | Prepaid or included usage remains |
| `overage` | `true` | Credits gone; usage invoices as it accrues |
| `at_risk` | `true` | Debt in the lead window; invoice is collecting |
| `blocked` | `false` | Mint/signer refuse; see `reason` |

| `reason` (blocked) | Integrator action |
| --- | --- |
| `no_payment_method` | Attach a default card, then retry |
| `overage_not_available` | Add prepaid (sandbox Starter hard gate) |
| `debt_ceiling_reached` | Wait for settlement; or raise `softNegativeUsdMicros` (≥ $2.00 or `0`) |
| `billing_unavailable` | Transient; retry |

The same `reason` codes appear on the signer-token mint **402**. Soft-negative must be `0` (unlimited) or ≥ `$2.00` — smaller ceilings deadlock under Stripe’s `$0.50` minimum charge.

## Auto-top-up vs invoice collect

- **Auto-top-up** is an off-session PaymentIntent on the connected account, then a Konnect grant onto the **matching** payer (`eu_` or `sbx_eu_`). Sandbox apps must charge with the sandbox key (not `sk_live_`).
- **`POST …/billing/collect`** asks settlement to raise gathering lines. Merchant live uses Custom Invoicing + Connect charge. Sandbox merchant customers stay on the sandbox/free profile (no live Custom Invoicing).

## Webhooks (platform, not Builder)

| Plane | Path | Secrets |
| --- | --- | --- |
| Live Connect | `POST /webhooks/stripe` | `STRIPE_WEBHOOK_SECRET` / `STRIPE_CONNECT_WEBHOOK_SECRET` |
| Sandbox Connect | `POST /webhooks/stripe/sandbox` | `STRIPE_SANDBOX_WEBHOOK_SECRET` / `STRIPE_SANDBOX_CONNECT_WEBHOOK_SECRET` |

Do **not** reuse staging `whsec_` on production. Subscribe at least `account.updated`, Checkout / SetupIntent / PaymentIntent / `payment_method.attached`. Plane mismatch (sandbox event vs `stripeLivemode=true`) is ignored so test cards cannot mutate live apps.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Wallet routes `404` | `m2m_…` sibling, not `app_…` / `web_…` |
| `stripe_connect_required` | `ACTIVATION_GATE_MODE` is enforcing; finish Account Link |
| Cannot PATCH `stripeLivemode` | Disconnect Connect first |
| Top-up paid, balance unchanged | Wrong plane: live grant vs `sbx_eu_`, or owner sandbox webhook ignored |
| Auto-top-up never fires | No default PM; not merchant; or overage path ran first historically — reload must run at spendable=$0 |
| `collect` → `skipped` | Debt under `$0.50` or included usage still covers it |
| `collect` → `queued` but no invoice | Settlement Kafka lane / OpenMeter notify not bootstrapped |
| `debtSource: "meter_estimate"` | No gathering invoice — merchant billing profile missing |
| Streaming 402 after `sdkToken` mint | Token is valid; **payer** is blocked — read `billing/state` (this skill), not the token skill |

## Key files

| Area | Path |
| --- | --- |
| Connect + livemode | `src/lib/stripe/merchant-connect.ts` |
| Sandbox vs live keys | `src/lib/stripe/connect-accounts.ts` |
| Auto-top-up | `src/lib/stripe/auto-topup.ts` |
| Payer keys `eu_` / `sbx_eu_` | `src/lib/openmeter/customer-key.ts`, `billing-identity.ts` |
| Wallet / top-up / state | `src/app/api/v1/apps/[id]/billing/wallet/*`, `billing/state`, `billing/collect` |
| Webhooks | `src/app/webhooks/stripe/route.ts`, `…/sandbox/route.ts`, `handle-post.ts` |
| Payments UI | `src/components/apps/PaymentsTab.tsx` |
