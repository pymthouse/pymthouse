ALTER TABLE "app_billing_config" ADD COLUMN IF NOT EXISTS "stripe_livemode" boolean DEFAULT true NOT NULL;--> statement-breakpoint
