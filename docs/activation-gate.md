# Builder app activation gate

Status: **implemented (default off)**. Resolver and choke points live in
`src/lib/activation/`. Controlled by `ACTIVATION_GATE_MODE`
(`off` | `log` | `enforce_revenue` | `enforce`). Shipping with `off` does not
change live request behaviour; flip the env to advance rollout phases.

Depends on platform default app (#313) and Stripe Connect merchant accounts
(PR #124 / `feat/configure-stripe`).

This document specifies how PymtHouse decides whether a developer app may provision
end users and whether it may sell paid plans to them.

## Problem

Today an app is live the moment it is created. `developer_apps.status` defaults to
`approved`, `checkAppAccess` returns `allowed: true` for any registered client, and
`POST /api/v1/apps/{id}/users` provisions billable end users with no solvency check.
Those users can immediately mint signer tokens and consume network capacity, which
PymtHouse settles to orchestrators in ETH.

The exposure is therefore **unbounded network spend attributable to an app whose owner
has not agreed to pay for it**. Stripe Connect is frequently proposed as the fix, but
Connect is the rail by which a *Builder collects from their own users* — it does not,
by itself, guarantee that PymtHouse is paid. Conflating the two produces a gate that is
simultaneously too strict (blocks integration before any money is at risk) and too weak
(a Builder may price retail at $0 and burn network spend while the platform's
`application_fee_bps` collects a percentage of nothing).

## Design principle: two independent rails

| Rail | Who pays whom | Always on? | Gated by |
|---|---|---|---|
| **Cost** | App owner pays PymtHouse for all network usage their app generates | Yes | Owner chargeability (Sandbox Starter balance, or Owner Paid + card) + end-user cap |
| **Revenue** | Builder's end users pay the Builder | Opt-in | Stripe Connect readiness |

The cost rail already exists and is proven: Explorers on the platform default app
(**Livepeer Direct**) bill to `buildOwnerCustomerKey(users.id)` against **Owner
Sandbox Starter** (hard balance gate) or **Owner Paid** (chargeable payment method
required; overage invoices `charge_automatically`) with prepaid credits and an admin
MoonPay top-up path. Builder apps reuse it unchanged.

### Balance gate (design.md §4)

| Owner plan | Spendable = 0 | Mint / activation cost check |
| --- | --- | --- |
| **Owner Sandbox Starter** | Hard stop | Fail mint (`trial_credits_exhausted`) and block new end-user provisioning |
| **Owner Paid tier** + default PM | Allow past zero | `ownerWalletAllowsOverageInvoicing` (any `pymthouse_owner_paid*`) → overage invoices; mint may continue |

A card alone while still on Sandbox Starter does **not** unlock overage — an explicit
**Upgrade** to an Owner Paid tier is required (attach PM ≠ subscribe). Verified by
`mintAllowanceGateDecision` / `enforceMintAllowanceGate`
(`src/lib/oidc/mint-user-signer-token.ts`) and `resolveAppActivation`
(`src/lib/activation/app-activation.ts`). Unit coverage:
`mint-user-signer-token.test.ts` (zero spendable reject vs `allowsOverageInvoicing`
allow) and `app-activation.test.ts` (empty wallet + Paid/PM allows provision).

The consequence is that **end-user provisioning is never gated on Stripe**. It is gated
on whether the owner can pay. Stripe Connect gates only the two operations that cannot
physically complete without a connected account: activating a priced plan, and creating
an end-user checkout session.

## Billing modes

`app_billing_config.billing_mode` is authoritative:

- **`owner_rollup`** (default for every new app) — end-user usage aggregates to the
  owner's shared billing wallet. The owner is invoiced by PymtHouse. No Stripe account
  is required. Suitable for internal tools, evaluation, and any Builder who does not
  resell.
- **`merchant`** — the Builder charges their own end users through their Stripe
  connected account. PymtHouse takes `application_fee_bps`. Requires Connect readiness.
  The cost rail still applies: network usage continues to meter to the owner wallet.

Switching `owner_rollup → merchant` requires Connect readiness. Switching back is
permitted and does not cancel existing end-user subscriptions; it only blocks new
checkouts.

## Readiness predicate

```ts
// src/lib/activation/app-activation.ts (new)
export type ActivationReason =
  | "owner_payment_method_required"
  | "end_user_cap_reached"
  | "stripe_connect_required"
  | "stripe_connect_pending";

export type AppActivation = {
  clientId: string;
  billingMode: "owner_rollup" | "merchant";
  connectReady: boolean;
  canProvisionEndUsers: boolean;
  canSellPaidPlans: boolean;
  reason: ActivationReason | null;
};
```

Derivation:

```
connectReady =
     stripe_connected_account_id IS NOT NULL
  && stripe_charges_enabled
  && stripe_details_submitted

ownerBillable =
     ownerSpendableUsdMicros > 0
  || ownerWalletAllowsOverageInvoicing
     // Owner Paid tier (`pymthouse_owner_paid*`) + chargeable PM — not card alone on Starter

canProvisionEndUsers =
     is_platform_default
  || (ownerBillable && appUserCount < end_user_cap)

canSellPaidPlans =
     billing_mode = 'merchant' && connectReady
```

Notes:

- `stripe_payouts_enabled` is **deliberately excluded**. Stripe routinely withholds
  payouts (pending verification, restricted region) on accounts that can charge
  normally. Requiring it would block legitimate merchants. `charges_enabled &&
  details_submitted` is the readiness test PR #124 already computes in
  `persistConnectedAccountFlags`.
- `app_billing_config` rows are created lazily. A missing row MUST resolve to
  `billing_mode = 'owner_rollup'`, `connectReady = false`, and the default cap.
- The platform default app (`is_platform_default = 1`) is exempt from provisioning
  checks. It is the Explorer on-ramp and is administered by platform admins only.
- `ownerSpendableUsdMicros` reuses `getSpendableUsdMicros` — included plan allowance
  plus prepaid credits — so the gate agrees with the existing signer mint gate rather
  than introducing a second definition of solvency.
- An empty wallet alone does **not** block **when** the owner is on an **Owner Paid
  tier** (`pymthouse_owner_paid*`) with a chargeable payment method
  (`ownerWalletAllowsOverageInvoicing`). Sandbox Starter with spendable=0 is a hard
  stop even if a card is already attached (explicit Upgrade required). Only
  an owner with neither spendable balance nor Paid+PM overage path is unbillable — that
  is what the cost rail refuses, because the usage would be uncollectable by construction.
- Chargeability for the overage path uses `ownerWalletAllowsOverageInvoicing`
  (`owner-paid-plan.ts`), which requires an Owner Paid tier subscription **and** a Stripe
  **default** PM (`invoice_settings.default_payment_method` / Konnect
  `default_payment_method_id`) — attached-but-not-default does not unlock. The cheaper
  prepaid/balance read runs first; PM/overage lookup runs
  only after spendable is exhausted. Lookup returns `null` when platform billing is
  unconfigured or Stripe/OpenMeter is unreachable, and `null` fails open on the
  **activation** path: an outage must not freeze provisioning.

## Choke points

### Cost rail — enforced

The floor is a single call inside `provisionAppUserBilling`, because five distinct call
sites create `app_users` rows and guarding only the obvious REST route is bypassable:

| Call site | File | Behaviour |
|---|---|---|
| Builder REST upsert | `src/app/api/v1/apps/[id]/users/route.ts:116` | Guard + typed 402/403 |
| App-user key mint | `src/app/api/v1/apps/[id]/users/[externalUserId]/keys/route.ts` | Guard + typed 402/403 |
| Signer token mint | `src/lib/oidc/mint-user-signer-token.ts:218` | Guard, raise `MintUserSignerTokenError` |
| Onramp session create | `src/lib/onramp/sessions.ts:92` | Inherits floor |
| Explorer network key | `src/lib/onboarding.ts:190` | Exempt (platform default app) |

Routes call `assertAppCanProvisionUsers(clientId)` explicitly so they can return a
well-formed error; `provisionAppUserBilling` calls it again as a defence-in-depth floor
for any future caller.

### Deliberately not gated

`resolveOrCreateAppUser` (`src/lib/usage/record-signed-ticket.ts:5`) runs on the usage
ingest path. Gating it would silently discard signed-ticket records for users that
already exist, losing both revenue attribution and audit trail. Ingest must always
record what the network actually did; solvency is enforced at mint time, before work is
`grantAllowanceUsdMicros` is likewise ungated at the library layer — crediting an
account must never be blocked by that account being empty, and the onramp / Stripe
top-up / admin grant paths rely on that to refill a dry wallet.

The Builder route `POST …/users/{externalUserId}/allowances` no longer mints free
credits (`403 free_grant_admin_only`). Platform admins grant via
`POST /api/v1/admin/billing/owners/{userId}/grants` (customer-service). Paid top-ups
use Stripe Checkout → webhook (`source: topup`).

### Revenue rail — enforced

| Operation | File | Condition |
|---|---|---|
| Activate a priced plan | `src/app/api/v1/apps/[id]/plans/route.ts:426` | `status = 'active' && price > 0` requires `canSellPaidPlans` |
| End-user checkout | `src/app/api/v1/apps/[id]/billing/checkout/route.ts` | Requires `canSellPaidPlans` |
| End-user plan change | `src/app/api/v1/apps/[id]/users/[externalUserId]/subscription/change/route.ts` | Same `planRequiresSellGate` test on the **target** plan |

Free plans (`price = 0`), draft plans, and the per-app Starter plan are unaffected, so a
Builder can model their catalogue fully before connecting Stripe.

## Schema

Migration `0035_app_activation_gate.sql` — sequenced after PR #124's renumbered
`0032`–`0034`:

```sql
ALTER TABLE "app_billing_config"
  ADD COLUMN IF NOT EXISTS "billing_mode" text NOT NULL DEFAULT 'owner_rollup';
--> statement-breakpoint
ALTER TABLE "app_billing_config"
  ADD COLUMN IF NOT EXISTS "end_user_cap" integer NOT NULL DEFAULT 10000;
--> statement-breakpoint
ALTER TABLE "app_billing_config"
  ADD COLUMN IF NOT EXISTS "activation_notified_at" text;
--> statement-breakpoint
-- Grandfather: any app already charging through Connect is a merchant.
UPDATE "app_billing_config"
   SET "billing_mode" = 'merchant'
 WHERE "stripe_connected_account_id" IS NOT NULL
   AND "stripe_charges_enabled" = true;
```

`end_user_cap` is per-app and admin-adjustable so a growing Builder on `owner_rollup`
can be raised without forcing a mode change. The activation counter includes only
**active** `app_users` rows — `DELETE …/users` (soft-deactivate to `inactive`) frees
a slot so developers can reclaim capacity without an admin cap raise. Reactivating
an inactive identity consumes a free slot under the same gate as creating a new one.

## Error contract

Responses follow RFC 9457 (Problem Details for HTTP APIs) with an additional
machine-readable `code` so integrators can branch without parsing prose. Status code
selection follows RFC 9110 §15.5.

| Condition | Status | `code` |
|---|---|---|
| Owner wallet empty **and** no Paid+default-PM overage path | `402` | `owner_payment_method_required` |
| Per-app user cap reached | `403` | `end_user_cap_reached` |
| Paid plan / checkout without Connect | `403` | `stripe_connect_required` |
| Connect started, capabilities not yet granted | `403` | `stripe_connect_pending` |

`402 Payment Required` matches the existing signer mint gate
(`MintUserSignerTokenError(..., 402)`), so integrators handle one status consistently
across provisioning and minting. Its `actionUrl` points at the platform billing page,
where the owner's payment methods are managed — the other reasons point at per-app
settings.

```json
{
  "type": "https://pymthouse.com/problems/app-not-activated",
  "title": "Payment method required",
  "status": 402,
  "code": "owner_payment_method_required",
  "billingMode": "owner_rollup",
  "actionUrl": "https://pymthouse.com/billing",
  "correlation_id": "..."
}
```

`GET /api/v1/apps/{id}` gains an `activation` object carrying the full `AppActivation`
shape so the dashboard and integrator backends read the same state the gate enforces.

## Rollout

Controlled by `ACTIVATION_GATE_MODE` (`off` | `log` | `enforce_revenue` | `enforce`,
default `off`).

1. **Phase 0 — Observe.** Ship the resolver, the `activation` field on
   `GET /api/v1/apps/{id}`, and the dashboard banner. No request is refused
   (`ACTIVATION_GATE_MODE=off`).
2. **Phase 1 — Log.** `ACTIVATION_GATE_MODE=log`. Every would-be denial writes an audit
   row (`activation_gate_would_deny`). Review real traffic for false positives —
   particularly apps whose owners are solvent but whose `app_billing_config` row is
   absent.
3. **Phase 2 — Enforce revenue rail.** `ACTIVATION_GATE_MODE=enforce_revenue`. Turn on
   plan-activation and checkout gating first. It is the lowest-risk half: it cannot
   break a running integration, only a new monetisation attempt.
4. **Phase 3 — Enforce cost rail.** `ACTIVATION_GATE_MODE=enforce`. Turn on provisioning
   gating. Notify owners whose apps would be affected via `activation_notified_at`
   before flipping.

Enforcement must never retroactively disable existing end users. The gate blocks
*creation*; existing users continue until their owner's balance is exhausted, which the
mint gate already handles.

## Design decisions and trade-offs

1. **Cost and revenue rails are separated.** The alternative — block all end-user
   provisioning until Stripe Connect is ready — was rejected. It puts a merchant
   onboarding form between a Builder and their first successful API call, immediately
   after PR #313 invested in a low-friction Explorer/Builder wizard, while still not
   guaranteeing PymtHouse gets paid.

2. **`owner_rollup` is the default, not a fallback.** Treating it as a future
   alternative would mean shipping a hard wall now and softening it later. Defaulting to
   roll-up means the platform is paid from day one on every app, and Stripe becomes a
   feature unlock rather than a barrier.

3. **`application_fee_bps` does not protect the platform.** A flat basis-point cut of
   Builder retail revenue under-recovers whenever retail price is below network cost.
   Metering network cost to the owner wallet in *both* billing modes is what makes
   platform revenue independent of a Builder's pricing decisions. The application fee
   remains as margin on resale, not as cost recovery.

4. **One enforcement floor, several friendly callers.** Guarding only routes leaves the
   signer-mint path (RFC 8693 token exchange with `sign:mint_user_token`) open. Guarding
   only `provisionAppUserBilling` produces opaque 500s. Doing both costs one extra
   cheap read and yields correct behaviour with good error messages.

5. **Ingest is never gated.** Accepting usage records for an insolvent account is
   correct: the work already happened and must be billed and audited. Authorisation
   belongs at mint time.

6. **`payouts_enabled` is not part of readiness.** See the predicate section.

7. **Per-app cap rather than a global one.** Different Builders legitimately need
   different scale on roll-up. A per-app integer is a single admin edit, versus a code
   change or a mode migration.

## Out of scope

- Reinstating the legacy `developer_apps` review workflow (`submitted`, `in_review`,
  `rejected`, `reviewer_notes`). Those columns stay dormant; activation is a billing
  state, not an editorial one.
- Marketplace publishing, which remains disabled.
- Changing the meter event schema or the `app_<clientId>:<externalUserId>` subject
  convention.
- Per-end-user spend limits set by the Builder.

## Related code

- Owner wallet / subject keys: `src/lib/openmeter/customer-key.ts`
- Solvency: `src/lib/openmeter/spendable-allowance.ts` (`getSpendableUsdMicros`)
- Owner chargeability: `src/lib/openmeter/owner-payment-method.ts`
  (`ownerHasChargeablePaymentMethod`)
- Provisioning floor: `src/lib/billing/provision-app-user.ts`
- Signer mint gate: `src/lib/oidc/mint-user-signer-token.ts`
- Connect state + webhook (PR #124): `src/lib/stripe/merchant-connect.ts`,
  `src/lib/stripe/connect-accounts.ts`, `src/app/webhooks/stripe/route.ts`
- Platform default app: `src/lib/platform-default-app.ts`
- Ownership checks: `src/lib/provider-apps.ts`

## Implementation tasks

### Phase 0 — Resolver and visibility

- [x] Add `0035_app_activation_gate.sql` and the matching `appBillingConfig` columns in
      `src/db/schema.ts`.
- [x] Create `src/lib/activation/app-activation.ts` with `resolveAppActivation` and
      `assertAppCanProvisionUsers` / `assertAppCanSellPaidPlans`.
- [x] Unit tests covering: missing `app_billing_config` row, platform default exemption,
      `charges_enabled` false, `details_submitted` false, cap boundary, zero balance.
- [x] Surface `activation` on `GET /api/v1/apps/{id}` and in `AppSettingsScreen`.
- [x] Dashboard banner on the Payments tab describing the current mode and next action.

### Phase 1 — Log-only

- [x] Add `ACTIVATION_GATE_MODE` to `.env.example` and `scripts/validate-env.js`.
- [x] Wire guards into the four enforced call sites in log mode; emit
      `activation_gate_would_deny` audit rows.
- [ ] Run for one full billing cycle; review denials against live traffic.

### Phase 2 — Revenue rail

- [x] Enforce `canSellPaidPlans` on plan activation and `POST .../billing/checkout`
      (`ACTIVATION_GATE_MODE=enforce_revenue`).
- [x] RFC 9457 problem responses with `code` and `actionUrl`.
- [x] Document the modes and error codes in `docs/builder-api.md`.

### Phase 3 — Cost rail

- [x] Enforce `canProvisionEndUsers` (`ACTIVATION_GATE_MODE=enforce`); populate
      `activation_notified_at` on first denial.
- [ ] Owner notification before enforcement is enabled in production.
- [x] Admin/owner control to adjust `end_user_cap` and force `billing_mode`
      (`PATCH .../billing/stripe`).

## Success criteria

1. No app can accrue network spend that is not attributable to a **billable** owner —
   one with either a prepaid balance or a payment method OpenMeter can charge.
2. A new Builder reaches a successful signed job without touching Stripe.
3. No existing app changes behaviour when the migration is applied at `off` or `log`.
4. One definition of solvency is shared by the provisioning gate and the signer mint
   gate.
5. Every denial is machine-readable and links to the action that resolves it.
