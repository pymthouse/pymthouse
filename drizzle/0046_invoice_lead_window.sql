ALTER TABLE "app_billing_config"
  ADD COLUMN IF NOT EXISTS "invoice_lead_usd_micros" text;--> statement-breakpoint
-- Lift positive ceilings below the $2 floor. Anything smaller deadlocks: debt
-- reaches the ceiling while every invoice raised on the way is under Stripe's
-- $0.50 minimum and cannot be collected. 0 means "no ceiling" and is left alone.
UPDATE "app_billing_config"
  SET "soft_negative_usd_micros" = '2000000'
  WHERE "soft_negative_usd_micros" ~ '^[0-9]+$'
    AND "soft_negative_usd_micros"::numeric > 0
    AND "soft_negative_usd_micros"::numeric < 2000000;--> statement-breakpoint
-- Never reached OpenMeter; superseded by invoice_lead_usd_micros.
ALTER TABLE "app_billing_config"
  DROP COLUMN IF EXISTS "invoice_threshold_usd_micros";
