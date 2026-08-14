-- Optional per-user prepaid auto-reload (off-session Connect PaymentIntent).
-- Distinct from overage invoicing: this grants spendable credits before deny.
ALTER TABLE "app_users"
  ADD COLUMN IF NOT EXISTS "auto_top_up_enabled" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "app_users"
  ADD COLUMN IF NOT EXISTS "auto_top_up_usd_micros" text;
