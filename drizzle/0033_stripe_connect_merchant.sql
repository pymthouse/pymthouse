ALTER TABLE "app_billing_config" ADD COLUMN IF NOT EXISTS "stripe_connected_account_id" text;--> statement-breakpoint
ALTER TABLE "app_billing_config" ADD COLUMN IF NOT EXISTS "stripe_onboarding_method" text;--> statement-breakpoint
ALTER TABLE "app_billing_config" ADD COLUMN IF NOT EXISTS "stripe_charges_enabled" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "app_billing_config" ADD COLUMN IF NOT EXISTS "stripe_payouts_enabled" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "app_billing_config" ADD COLUMN IF NOT EXISTS "stripe_details_submitted" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "app_billing_config" ADD COLUMN IF NOT EXISTS "application_fee_bps" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "app_billing_config" ADD COLUMN IF NOT EXISTS "connect_payments_only" boolean NOT NULL DEFAULT false;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_user_stripe_customers" (
  "id" text PRIMARY KEY NOT NULL,
  "client_id" text NOT NULL,
  "external_user_id" text NOT NULL,
  "stripe_connected_account_id" text NOT NULL,
  "stripe_customer_id" text NOT NULL,
  "openmeter_customer_id" text,
  "openmeter_customer_key" text,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "app_user_stripe_customers"
    ADD CONSTRAINT "app_user_stripe_customers_client_id_developer_apps_id_fk"
    FOREIGN KEY ("client_id") REFERENCES "public"."developer_apps"("id")
    ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_app_user_stripe_customers_unique"
  ON "app_user_stripe_customers" ("client_id","external_user_id");
