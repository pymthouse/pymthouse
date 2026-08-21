ALTER TABLE "app_billing_config"
  ADD COLUMN IF NOT EXISTS "billing_mode" text NOT NULL DEFAULT 'owner_rollup';
--> statement-breakpoint
ALTER TABLE "app_billing_config"
  ADD COLUMN IF NOT EXISTS "end_user_cap" integer NOT NULL DEFAULT 25;
--> statement-breakpoint
ALTER TABLE "app_billing_config"
  ADD COLUMN IF NOT EXISTS "activation_notified_at" text;
--> statement-breakpoint
-- Grandfather: any app already charging through Connect is a merchant.
UPDATE "app_billing_config"
   SET "billing_mode" = 'merchant'
 WHERE "stripe_connected_account_id" IS NOT NULL
   AND "stripe_charges_enabled" = true;
