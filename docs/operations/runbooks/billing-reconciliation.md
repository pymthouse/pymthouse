# Billing Reconciliation Runbook

Use this runbook when usage totals, billing events, or account/transaction views look inconsistent.

## Symptoms

- app usage page totals do not match expected traffic
- billing dashboard shows missing or duplicated costs
- end-user transactions do not align with usage activity
- owner/platform breakdowns drift from expected fee logic

## Primary Checks

1. Confirm control-plane health:
   - `GET /api/v1/health`
2. Inspect recent writes to:
   - `usage_records`
   - `usage_billing_events`
   - `transactions`
   - `stream_sessions`
3. Review logs for:
   - signer payment persistence failures
   - pricing/oracle fetch failures
   - usage aggregation query errors

## Likely Failure Areas

- signer runtime accepted requests but failed billing persistence
- price/oracle data missing or stale
- reporting query bug or partial release regression
- duplicated write path or retry behavior

## Immediate Mitigation

- freeze assumptions before manual correction:
  - identify affected app ids, sessions, transactions, and time window
- verify whether the mismatch is:
  - display-only
  - missing writes
  - duplicated writes
- if release-related, roll back the affected control-plane or signer image before backfilling data

## Recovery Steps

- repair data only after identifying the write-path failure mode
- re-run any safe reconciliation or backfill tooling if it exists
- validate totals at:
  - raw write level
  - aggregated app usage view
  - end-user/account view

## Follow-up

- add or improve automation for the mismatch class you encountered
- document the exact tables and recomputation logic used during the incident
