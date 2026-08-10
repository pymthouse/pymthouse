ALTER TABLE "app_billing_config"
  ADD COLUMN IF NOT EXISTS "soft_negative_usd_micros" text;--> statement-breakpoint
ALTER TABLE "app_users"
  ADD COLUMN IF NOT EXISTS "auto_top_up_enabled" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "app_users"
  ADD COLUMN IF NOT EXISTS "auto_top_up_usd_micros" text;--> statement-breakpoint
ALTER TABLE "app_users"
  ADD COLUMN IF NOT EXISTS "auto_top_up_before_soft_negative" boolean NOT NULL DEFAULT true;
