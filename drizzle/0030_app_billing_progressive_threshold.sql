ALTER TABLE "app_billing_config"
  ADD COLUMN IF NOT EXISTS "progressive_billing" boolean NOT NULL DEFAULT true;--> statement-breakpoint
ALTER TABLE "app_billing_config"
  ADD COLUMN IF NOT EXISTS "invoice_threshold_usd_micros" text;
