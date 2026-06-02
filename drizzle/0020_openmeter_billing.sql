-- OpenMeter billing stack: config tables, tenant billing, retail pricing, starter plans,
-- API key ownership, and removal of legacy wei credit balance.
-- Consolidates the former 0020–0028 migrations from feat/openmeter-async-flow.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_openmeter_config" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"mode" text DEFAULT 'pymthouse_hosted' NOT NULL,
	"base_url" text,
	"api_key_encrypted" text,
	"meter_slug" text DEFAULT 'network_fee_usd_micros' NOT NULL,
	"trial_feature_key" text DEFAULT 'network_spend' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_app_openmeter_config_client_id" ON "app_openmeter_config" USING btree ("client_id");
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "app_openmeter_config"
    ADD CONSTRAINT "app_openmeter_config_client_id_developer_apps_id_fk"
    FOREIGN KEY ("client_id") REFERENCES "public"."developer_apps"("id")
    ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_ingest_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"request_id" text NOT NULL,
	"openmeter_event_id" text NOT NULL,
	"external_user_id" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_usage_ingest_receipts_client_request" ON "usage_ingest_receipts" USING btree ("client_id","request_id");
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "usage_ingest_receipts"
    ADD CONSTRAINT "usage_ingest_receipts_client_id_developer_apps_id_fk"
    FOREIGN KEY ("client_id") REFERENCES "public"."developer_apps"("id")
    ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "openmeter_plan_id" text;
--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "openmeter_plan_version" integer;
--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "last_synced_at" text;
--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "sync_error" text;
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "openmeter_subscription_id" text;
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "openmeter_customer_key" text;
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "external_user_id" text;
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "stripe_checkout_session_id" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_billing_config" (
  "id" text PRIMARY KEY NOT NULL,
  "client_id" text NOT NULL REFERENCES "developer_apps"("id"),
  "stripe_connect_status" text NOT NULL DEFAULT 'disconnected',
  "openmeter_stripe_app_id" text,
  "openmeter_billing_profile_id" text,
  "default_currency" text NOT NULL DEFAULT 'USD',
  "checkout_success_url" text,
  "checkout_cancel_url" text,
  "connected_at" text,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_app_billing_config_client_id"
  ON "app_billing_config" ("client_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_billing_oauth_states" (
  "id" text PRIMARY KEY NOT NULL,
  "state" text NOT NULL UNIQUE,
  "client_id" text NOT NULL REFERENCES "developer_apps"("id"),
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "expires_at" text NOT NULL,
  "created_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_app_billing_oauth_states_expires"
  ON "app_billing_oauth_states" ("expires_at");
--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "overage_rate_usd" text;
--> statement-breakpoint
UPDATE "plans"
SET "overage_rate_usd" = '0.000001'
WHERE "overage_rate_usd" IS NULL;
--> statement-breakpoint
ALTER TABLE "plan_capability_bundles" ADD COLUMN IF NOT EXISTS "retail_rate_usd" text;
--> statement-breakpoint
UPDATE "plan_capability_bundles"
SET "retail_rate_usd" = (
  0.000001 * (1 + COALESCE("upcharge_percent_bps", 0)::numeric / 10000)
)::text
WHERE "retail_rate_usd" IS NULL
  AND "upcharge_percent_bps" IS NOT NULL
  AND "upcharge_percent_bps" > 0;
--> statement-breakpoint
ALTER TABLE "plan_capability_bundles" DROP COLUMN IF EXISTS "upcharge_percent_bps";
--> statement-breakpoint
ALTER TABLE "plans" DROP COLUMN IF EXISTS "overage_rate_wei";
--> statement-breakpoint
ALTER TABLE "plan_capability_bundles"
  ADD COLUMN IF NOT EXISTS "openmeter_feature_key" text;
--> statement-breakpoint
UPDATE "plans"
SET "name" = trim(
  regexp_replace(
    regexp_replace(trim("name"), '[^A-Za-z0-9 _.\-]', ' ', 'g'),
    '\s+',
    ' ',
    'g'
  )
)
WHERE COALESCE("is_network_default", false) = false
  AND trim("name") ~ '[^A-Za-z0-9 _.\-]';
--> statement-breakpoint
UPDATE "plans"
SET "name" = 'Plan'
WHERE COALESCE("is_network_default", false) = false
  AND (trim("name") = '' OR "name" IS NULL);
--> statement-breakpoint
UPDATE "plans"
SET
  "openmeter_plan_id" = NULL,
  "openmeter_plan_version" = NULL,
  "last_synced_at" = NULL,
  "sync_error" = NULL
WHERE
  COALESCE("is_network_default", false) = false
  AND "type" IS DISTINCT FROM 'free'
  AND "status" = 'active';
--> statement-breakpoint
ALTER TABLE "plans"
  ADD COLUMN IF NOT EXISTS "is_starter_default" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_plans_starter_default_per_client"
  ON "plans" ("client_id")
  WHERE "is_starter_default" = true;
--> statement-breakpoint
INSERT INTO "plans" (
  "id",
  "client_id",
  "name",
  "type",
  "price_amount",
  "price_currency",
  "status",
  "included_usd_micros",
  "billing_cycle",
  "is_network_default",
  "is_starter_default",
  "created_at",
  "updated_at"
)
SELECT
  gen_random_uuid()::text,
  p."client_id",
  '__pymthouse_starter__',
  'usage',
  '0',
  'USD',
  'active',
  '5000000',
  'monthly',
  false,
  true,
  to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM "plans" p
WHERE p."is_network_default" = true
  AND NOT EXISTS (
    SELECT 1
    FROM "plans" s
    WHERE s."client_id" = p."client_id"
      AND s."is_starter_default" = true
  );
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "app_user_id" text;
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "key_prefix" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "api_keys"
    ADD CONSTRAINT "api_keys_app_user_id_app_users_id_fk"
    FOREIGN KEY ("app_user_id") REFERENCES "public"."app_users"("id")
    ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_api_keys_app_user_id" ON "api_keys" ("app_user_id");
--> statement-breakpoint
ALTER TABLE "end_users" DROP COLUMN IF EXISTS "credit_balance_wei";
