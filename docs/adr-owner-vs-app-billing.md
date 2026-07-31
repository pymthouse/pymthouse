# ADR: Owner subscriptions vs. app subscriptions

Status: **proposed**.
Companion to [`activation-gate.md`](./activation-gate.md) and
[`adr-stripe-connect-openmeter-webhooks.md`](./adr-stripe-connect-openmeter-webhooks.md),
which established the cost/revenue rail split. This ADR applies that split to
**subscriptions and billing configuration**, which still conflate the two.

## Context

`activation-gate.md` already defines two independent rails:

| Rail | Who pays whom | Always on? |
|---|---|---|
| **Cost** | App owner pays PymtHouse for all network usage their apps generate | Yes |
| **Revenue** | Builder's end users pay the Builder | Opt-in (Connect) |

The rails are correct. What is not correct is that **the objects representing
them do not follow them**, so an owner with several apps cannot tell what they
are subscribed to, where their usage went, or who is billing whom.

### Symptom 1 — per-app config for an account-level relationship

`app_billing_config` has one row per app and mixes both rails in the same table
and the same UI tab:

| Field | Rail | Correct scope today? |
|---|---|---|
| `billing_mode` | Revenue | ✅ per app |
| `stripe_connected_account_id`, `stripe_*_enabled`, `stripe_onboarding_method` | Revenue | ⚠️ per app — but a Builder has one Stripe account, not one per app |
| `checkout_success_url`, `checkout_cancel_url`, `default_currency` | Revenue | ✅ per app |
| `progressive_billing`, `invoice_threshold_usd_micros` | Revenue (Builder → end users) | ✅ per app |
| `end_user_cap` | **Cost** | ❌ owner-editable; see Symptom 3 |
| `application_fee_bps` | **Platform revenue** | ❌ owner-editable; see Symptom 3 |

A developer who owns four apps configures four of these, and none of them is the
thing they actually bought — their PymtHouse plan.

### Symptom 2 — the owner as a customer of their own app

Owner usage historically metered to compound subjects
`app_…:{ownerId}` and `app_…:owner:{ownerId}` — the owner as an end user of
their own application. Migration away from this is already underway and
incomplete:

- `scripts/openmeter-migrate-owner-customers.ts` — moves owners onto a shared
  customer keyed by bare `{users.id}`, transfers prepaid balances, cancels
  subscriptions on legacy customers.
- `scripts/openmeter-dedupe-owner-subscriptions.ts` — its header states the
  problem directly: owners can hold an active subscription on both the shared
  wallet *and* legacy per-app wallets, "which shows as multiple tiles on Billing
  / Usage."
- `scripts/openmeter-release-legacy-subjects.ts` — releases the legacy subjects.
- `buildOwnerMeterSubjects()` still dual-reads all four forms, because the
  legacy state persists in live data.

This is remediation without a rule, so the state keeps being reachable.

### Symptom 3 — platform controls are editable by the party they constrain

`canManageMerchantBilling()` returns true when `app.ownerId === userId`, and
`PATCH /api/v1/apps/{id}/billing/stripe` accepts every field behind that one
check. Two of those fields are not the Builder's to set:

- **`application_fee_bps`** is PymtHouse's share of Connect payments. An app
  owner can set it to `0`. `activation-gate.md` anticipates a Builder pricing
  retail at `$0` so the fee "collects a percentage of nothing"; they do not need
  to bother — they can zero the fee directly.
- **`end_user_cap`** is the cost-rail guard against unbounded network spend by
  an owner who may not be able to pay. It is settable up to `1_000_000` by that
  owner. The activation copy even names the remedy: "End-user cap reached —
  raise the cap."

### Symptom 4 — the schema cannot express a platform subscription

`subscriptions.client_id` is `NOT NULL` and references `developer_apps`. A
subscription therefore *must* belong to an app. The owner's platform plan has no
app, so it exists only in OpenMeter and has no first-class local representation.
This is why the usage page renders a card titled "Subscription" with no plan
name and no statement of what it covers.

## Decision

**Three objects, each owned by exactly one rail. An owner is never a customer of
their own app.**

| # | Object | Relationship | Scope | Rail |
|---|---|---|---|---|
| 1 | **Platform subscription** | Owner → PymtHouse | **One per developer account** | Cost |
| 2 | **App retail plans** | End users → Builder | Per app | Revenue |
| 3 | **App billing config** | — | Per app, **revenue fields only** | Revenue |

Cost-rail and platform-revenue controls (`end_user_cap`, `application_fee_bps`)
move out of owner-editable configuration entirely.

### Rules

1. **An owner is never subscribed to a plan on an app they own.** Owner usage
   meters to `buildOwnerCustomerKey(users.id)` and nothing else. Enforced at the
   provisioning choke point, not just cleaned up by scripts.
2. **All cost-rail usage across all of an owner's apps rolls up to the single
   platform subscription.** This is already true mechanically; it becomes
   stated, visible, and enforced.
3. **`billing_mode` decides who bills the end user, never who pays PymtHouse.**
   In `merchant` mode the Builder collects from their end users *and* the owner
   still pays PymtHouse for the underlying network usage. Both are shown.
4. **Platform-protection fields are admin-only.** `end_user_cap` and
   `application_fee_bps` are rejected with `403` on the owner path.
5. **One Stripe connected account per owner**, opted into per app. A Builder
   onboards Connect once.

### Why not the alternative

Letting an owner subscribe to their own app's retail plan was considered and
rejected. In `merchant` mode it means the owner sells to themselves, routing
their own money through their own connected account minus a platform fee they
pay to themselves. It also double-counts: the same usage appears once on the
owner wallet and once as an app end user — precisely the duplicate tiles
`openmeter-dedupe-owner-subscriptions.ts` exists to clean up.

## Consequences

### UI

- `/billing` leads with the platform subscription, named, and states that it
  covers every app the owner owns.
- The usage page's subscription card names the plan and links to `/billing`.
- The app Payments tab shows only revenue-rail settings. Cost-rail values render
  read-only, attributed to the platform, with a link to `/billing`.
- Per-app usage remains per-app; the roll-up destination is stated on each.

### Schema

- Split `app_billing_config`: revenue fields stay; `end_user_cap` and
  `application_fee_bps` move to a platform-controlled location (an
  `owner_billing_config` row, or platform defaults with admin-only per-app
  override).
- Consider relaxing `subscriptions.client_id` to nullable, or adding an explicit
  `owner_subscriptions` table, so the platform plan has a local representation.
  Required for Symptom 4; deferrable if OpenMeter stays the source of truth.

### Migration

The path is the one the existing scripts already take, finished and made
irreversible:

1. **Backfill** — run `openmeter-migrate-owner-customers.ts` and
   `openmeter-dedupe-owner-subscriptions.ts` to completion across all owners.
2. **Enforce** — reject owner-as-own-app-customer at the provisioning choke
   point, so the legacy state is no longer reachable.
3. **Dual-read window** — `buildOwnerMeterSubjects()` keeps reading legacy
   compound subjects until backfill is verified clean.
4. **Cutover** — `openmeter-release-legacy-subjects.ts`, then drop the
   transitional forms from `buildOwnerMeterSubjects()`.
5. **Lock the platform fields** — admin-only `403` on `end_user_cap` and
   `application_fee_bps` (independent of the rest; ship first).

Step 5 is severable and should not wait for the model change — it closes a live
revenue and exposure hole.

### Risks

- Owners mid-migration may briefly see both a platform subscription and a legacy
  per-app tile. The dual-read window covers reads; the dedupe script covers
  writes. Do not drop transitional subjects before backfill is verified.
- Moving `application_fee_bps` out of owner control is a behaviour change for
  any Builder who has already lowered it. Audit current values before enforcing;
  a Builder who zeroed it is currently paying PymtHouse nothing on Connect
  volume.
