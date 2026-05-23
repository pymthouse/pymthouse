-- App-level billing display currency and oracle provider configuration.
-- Kept in a separate table so legacy developer_apps rows continue to work.

CREATE TABLE IF NOT EXISTS "app_billing_oracle_config" (
  "id" text PRIMARY KEY,
  "client_id" text NOT NULL REFERENCES "developer_apps"("id"),
  "billing_display_currency" text NOT NULL DEFAULT 'USD',
  "billing_oracle_provider_key" text NOT NULL DEFAULT 'global_eth_usd',
  "billing_oracle_provider_config" jsonb,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_app_billing_oracle_config_client_id"
  ON "app_billing_oracle_config" ("client_id");
