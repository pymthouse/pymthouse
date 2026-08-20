ALTER TABLE "app_billing_config" ALTER COLUMN "stripe_livemode" SET DEFAULT false;--> statement-breakpoint
UPDATE "app_billing_config"
SET "stripe_livemode" = false
WHERE "billing_mode" IS DISTINCT FROM 'merchant'
  AND ("stripe_connected_account_id" IS NULL OR "stripe_connected_account_id" = '');
