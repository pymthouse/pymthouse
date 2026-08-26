-- Park Merchant Connect onboarding per Stripe plane so an app can move between
-- sandbox and live without discarding either Connected Account.
-- app_billing_config keeps holding the *active* plane; this table is the
-- durable per-plane copy a switch restores from.
CREATE TABLE IF NOT EXISTS "app_stripe_connect_accounts" (
  "id" text PRIMARY KEY NOT NULL,
  "client_id" text NOT NULL,
  "livemode" boolean NOT NULL,
  "stripe_connected_account_id" text NOT NULL,
  "stripe_onboarding_method" text,
  "stripe_charges_enabled" boolean NOT NULL DEFAULT false,
  "stripe_payouts_enabled" boolean NOT NULL DEFAULT false,
  "stripe_details_submitted" boolean NOT NULL DEFAULT false,
  "connected_at" text,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "app_stripe_connect_accounts"
    ADD CONSTRAINT "app_stripe_connect_accounts_client_id_developer_apps_id_fk"
    FOREIGN KEY ("client_id") REFERENCES "public"."developer_apps"("id")
    ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_app_stripe_connect_accounts_plane"
  ON "app_stripe_connect_accounts" ("client_id", "livemode");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_app_stripe_connect_accounts_account"
  ON "app_stripe_connect_accounts" ("stripe_connected_account_id");--> statement-breakpoint

-- Backfill the active plane so existing merchants keep their onboarding when
-- they first switch away and back.
INSERT INTO "app_stripe_connect_accounts" (
  "id", "client_id", "livemode", "stripe_connected_account_id",
  "stripe_onboarding_method", "stripe_charges_enabled",
  "stripe_payouts_enabled", "stripe_details_submitted", "connected_at",
  "created_at", "updated_at"
)
SELECT
  gen_random_uuid()::text,
  "client_id",
  "stripe_livemode",
  "stripe_connected_account_id",
  "stripe_onboarding_method",
  "stripe_charges_enabled",
  "stripe_payouts_enabled",
  "stripe_details_submitted",
  "connected_at",
  now()::text,
  now()::text
FROM "app_billing_config"
WHERE "stripe_connected_account_id" IS NOT NULL
  AND "stripe_connected_account_id" <> ''
ON CONFLICT ("client_id", "livemode") DO NOTHING;--> statement-breakpoint

-- An app user now gets one Stripe customer per connected account, so the same
-- (client_id, external_user_id) may hold a sandbox and a live cus_ side by side.
DROP INDEX IF EXISTS "idx_app_user_stripe_customers_unique";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_app_user_stripe_customers_unique"
  ON "app_user_stripe_customers" ("client_id", "external_user_id", "stripe_connected_account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_app_user_stripe_customers_client_user"
  ON "app_user_stripe_customers" ("client_id", "external_user_id");
