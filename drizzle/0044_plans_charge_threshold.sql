-- Pay-Per-Use threshold-only charging (issue #398):
-- plans of type "usage" charge when accrued usage reaches this threshold
-- (credits first, then auto-debit) instead of at billing-cycle close.
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "charge_threshold_usd_micros" text;
