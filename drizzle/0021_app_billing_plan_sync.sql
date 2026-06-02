-- OpenMeter plan sync + tenant billing config
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "openmeter_plan_id" text;
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "openmeter_plan_version" integer;
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "last_synced_at" text;
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "sync_error" text;

ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "openmeter_subscription_id" text;
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "openmeter_customer_key" text;
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "external_user_id" text;
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "stripe_checkout_session_id" text;

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

CREATE UNIQUE INDEX IF NOT EXISTS "idx_app_billing_config_client_id"
  ON "app_billing_config" ("client_id");

CREATE TABLE IF NOT EXISTS "app_billing_oauth_states" (
  "id" text PRIMARY KEY NOT NULL,
  "state" text NOT NULL UNIQUE,
  "client_id" text NOT NULL REFERENCES "developer_apps"("id"),
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "expires_at" text NOT NULL,
  "created_at" text NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_app_billing_oauth_states_expires"
  ON "app_billing_oauth_states" ("expires_at");
