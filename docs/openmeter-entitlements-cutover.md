# Plan: OpenMeter entitlements cutover (later)

Status: **deferred**. Product UI now says **allowance**; billing still uses Konnect
`discounts.usage` + prepaid credits. This document is the roadmap if we later move
included cycle spend onto OpenMeter **entitlements**.

## Current model (keep until cutover)

```
Usage event (network_fee_usd_micros)
  → plan rate-card discounts.usage   # "included allowance" this cycle
  → then prepaid credits             # credit_then_invoice overage
```

Spendable balance for mint/signer gates is **custom math**:
`prepaid credits + remaining discounts.usage` (`spendable-allowance.ts`).

| Concept | OpenMeter object | User-facing name |
|--------|------------------|------------------|
| Included cycle $ | `discounts.usage` on plan rate card | Allowance |
| Top-up / overage wallet | Konnect prepaid credits | Prepaid credits |
| Feature access + optional grant balance | Entitlement (partially used for credit grants) | Not exposed in UI |

## Target model (optional)

```
Usage event
  → metered entitlement (issueAfterReset / grants)   # cycle allowance
  → optional hard/soft limit
  → prepaid credits only for explicit top-ups        # or fold into grants
```

Mint/signer gates would prefer a single OpenMeter read
(`customers…/entitlements/{feature}/value`) instead of discount − meter + credits.

## When this is worth doing

Do it if we need one or more of:

- Hard stop after included $ (no silent overage into credits)
- Grant history / reset cadence as first-class product features
- Collapse custom spendable math into one OpenMeter balance API
- Align with Konnect “Create entitlement” workflows for multi-feature products

**Skip** if Starter remains “included then prepaid” and that product shape is stable.
Renaming UI to “allowance” already matches how we talk about the current model.

## Design decisions / trade-offs

1. **Discount vs entitlement** — `discounts.usage` is a billing discount on the invoice;
   entitlements are feature balances. Same *user* story (“$5 included”), different
   Konnect objects and APIs.
2. **Credits stay or go** — Prefer keeping prepaid credits for manual top-ups at first;
   only merge into entitlement grants if we want one wallet metaphor.
3. **Migration risk** — Live Starter subscriptions on shared OpenMeter must be changed
   carefully (plan republish + subscription change/migrate). Shared OM + per-env DBs
   means migrate scripts must be scoped by owner/app, not “run in every region blindly.”
4. **No builder Entitlements UI** — Continue creating entitlements via plan sync, not a
   “Create entitlement” screen for app owners.

## Phased implementation

### Phase 0 — Prerequisites (small)

- [ ] Confirm Konnect settlement behavior when rate cards use `entitlementTemplate`
      *and* `credit_then_invoice` (overage after entitlement exhaustion).
- [ ] Inventory live plans: which already have `discounts.usage`, which have
      entitlement templates, which have neither.
- [ ] Decide feature key(s): keep `network_spend` vs split product features.

### Phase 1 — Dual-read (medium, low risk)

- [ ] Plan sync: optionally emit `entitlementTemplate` with `issueAfterReset` equal to
      `plans.includedUsdMicros` **without** removing `discounts.usage` yet.
- [ ] Billing/Usage meters: prefer entitlement remaining when present; fall back to
      discount − meter SUM.
- [ ] Spendable gate: `max(entitlement_balance, discount_remaining) + credits` (document
      exact formula to avoid double-counting).

### Phase 2 — Cutover included $ (large)

- [ ] Publish new plan versions: included $ via entitlement only; strip
      `discounts.usage` from Starter rate cards.
- [ ] Migration script: change/migrate active subscriptions onto new plan versions
      (pattern: `scripts/openmeter-migrate-starter-prepaid.ts`).
- [ ] Rewrite `getRemainingPlanDiscountUsdMicros` → entitlement value read; update
      `owner-billing-data` field naming (`discountUsdMicros` → `allowanceUsdMicros`
      end-to-end).
- [ ] Update tests (`konnect-routes`, mint gate, billing views).
- [ ] Dry-run on one owner, then apply; verify Usage meter + mint gate + Konnect invoice.

### Phase 3 — Optional: grants-only top-ups (larger)

- [ ] Map `createKonnectCreditGrant` / top-up API to entitlement grants.
- [ ] Retire or narrow prepaid credit UI if balances live only on entitlements.
- [ ] Revisit sidebar credit preview and Billing “Prepaid” section copy.

## Out of scope

- Exposing Konnect’s empty “Create entitlement” UI to builders.
- Changing meter event schema (`network_fee_usd_micros`).
- Per-region OpenMeter (tenant remains shared).

## Related code (today)

- Plan body: `src/lib/openmeter/konnect-plan-body.ts`, `plans-sync.ts`
- Spendable: `src/lib/openmeter/spendable-allowance.ts`
- Grants / entitlement reads: `src/lib/openmeter/entitlements.ts`, `konnect-credits.ts`
- UI allowance meter: `src/components/AllowanceProgressBar.tsx`
- Owner wallet cleanup: `scripts/openmeter-dedupe-owner-subscriptions.ts`
- Restore Starter included usage (`discounts.usage`) + resubscribe:
  `scripts/openmeter-fix-starter-allowance.ts`
  (`npm run openmeter:fix-starter-allowance -- --owner-id <users.id> --apply`)

## Success criteria

1. Single authoritative remaining-allowance number for gates and Billing UI.
2. No double-counting between discount and entitlement after Phase 2.
3. Starter users keep the same $ included behavior (or an explicit product change).
4. Migration is dry-runnable and owner-scoped against shared OpenMeter.
