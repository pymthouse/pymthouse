# ADR: Owner subscriptions vs. app subscriptions

Status: **accepted** — partially implemented. See
[Implementation status](#implementation-status) for what has shipped and what
is outstanding; this ADR stays until the deferred items land, because it also
records why rules now enforced in code exist.
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
| `progressive_billing`, `soft_negative_usd_micros`, `invoice_lead_usd_micros` | Revenue (Builder → end users) | ✅ per app |
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

### Usage reads follow customer id

**OpenMeter must be able to charge without consulting PymtHouse.** Its billing
automation runs per **customer**, over exactly that customer's
`usageAttribution.subjectKeys`. Any usage query that reads a different subject
set produces a number that cannot be reconciled with the invoice it purports to
explain.

The read path diverged from this. `buildOwnerMeterSubjects()` returns a
hand-built union of four forms — bare `{users.id}`, `owner:{id}`,
`app_…:{id}`, `app_…:owner:{id}` — while `ensureOwnerCustomer()` attributes only
`[bareId]` for existing customers, attaching the transitional forms
best-effort at create time. Its own comment records the split: *"Meter dual-read
for usage does not require those keys on the customer record."*

That divergence fails in the dangerous direction. Usage landing on an
unattributed subject is metered, shown in the PymtHouse UI, and **never
invoiced** — a revenue leak that looks like normal operation, because the UI
over-reports exactly the amount the billing engine ignores.

**Invariant: the subjects PymtHouse reads for a customer are the subjects
OpenMeter attributes to that customer.**

- Reads resolve subjects from the customer record
  (`resolveCustomerSubjectKeys`), not from a hand-built union. The displayed
  figure is therefore the billable figure by construction, and the transitional
  union narrows automatically as migration completes rather than needing a
  coordinated cut-over.
- The union survives only as a fallback for a failed customer lookup, so an
  outage degrades to the old behaviour instead of reporting zero.
- `classifyUsageAttributionConsistency` reports any subject carrying usage that
  no customer is attributed, as an `error`. This must reach zero before the
  transitional forms are dropped.
- Ingest should emit the canonical customer subject directly, so
  `subjectKeys = [customerKey]` is sufficient and the union disappears.

Consequence to expect: for an owner mid-migration, displayed usage may **fall**
to the attributed subset. That is a correction, not a regression — the
difference was never going to be billed. The audit surfaces the gap explicitly
rather than letting the UI absorb it.

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

## Implementation status

Shipped (PR #348):

- Symptom 3 — `applicationFeeBps` and `endUserCap` are rejected with `403` on
  the owner path; the Payments tab renders them read-only and attributed to the
  platform, and omits them from the PATCH body for non-admins.
  `scripts/audit-platform-billing-fields.ts` reports current values.
- Rule 1 — already satisfied before this ADR:
  `resolveOpenMeterBillingIdentity` routes an owner on their own app to the
  shared owner wallet, and the customer and starter-subscription paths honour
  it. One live gap was closed: `programmatic-tokens` hardcoded
  `user_type: "app_user"`, so owner traffic through that path was metered to
  `app_…:{ownerId}` and never invoiced.
- Rule 2 / UI — `/billing` leads with the account-level plan and lists every
  owned app with where its usage settles.
- Usage reads follow customer id — `resolveCustomerSubjectKeys` backs the owner
  read path, and `classifyUsageAttributionConsistency` reports unattributed
  usage.

Outstanding:

- **Symptom 1 (schema)** — resolved as *platform defaults with admin-only
  per-app override*, the second form this ADR allows.
  `platform-billing-defaults` supplies the values a new app inherits
  (`PYMTHOUSE_DEFAULT_END_USER_CAP`, `PYMTHOUSE_DEFAULT_APPLICATION_FEE_BPS`),
  so platform policy changes without a migration, and the per-app columns are
  admin-set overrides. The columns stay on `app_billing_config`; moving them to
  a separate table would be churn without behavioural gain now that
  authorization is correct.
- **Migration steps 1 and 3–4** — backfill, dual-read, cutover. Step 2
  (enforce) is done: an owner can no longer become a customer of their own app.
  Step 1 now has a completion signal — `npm run openmeter:audit-billing` runs
  `classifyUsageAttributionConsistency` per owner and exits non-zero while any
  usage sits on an unattributed subject. The transitional union in
  `buildOwnerMeterSubjects` and the three `openmeter-*-owner-*` scripts remain
  until that audit is clean; running it needs a live database and OpenMeter
  tenant.

- **Symptom 4** — unchanged, and larger than one nullable column.
  `plans.client_id` is `NOT NULL` as well as `subscriptions.client_id`, which is
  why `ensureStarterSubscriptionForAppUser` borrows "the requesting app's local
  Starter id" for an owner subscription. Giving the platform plan a real local
  row means making both nullable (or adding platform-scoped tables), rewiring
  owner subscription persistence, and backfilling existing rows — a multi-table
  change to core billing that should be verified against a real database.

### Risks

- Owners mid-migration may briefly see both a platform subscription and a legacy
  per-app tile. The dual-read window covers reads; the dedupe script covers
  writes. Do not drop transitional subjects before backfill is verified.
- Moving `application_fee_bps` out of owner control is a behaviour change for
  any Builder who has already lowered it. Audit current values before enforcing;
  a Builder who zeroed it is currently paying PymtHouse nothing on Connect
  volume.
