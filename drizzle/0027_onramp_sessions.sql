ALTER TABLE "app_users" ADD COLUMN IF NOT EXISTS "deposit_wallet_address" text;

CREATE TABLE IF NOT EXISTS "onramp_sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "client_id" text NOT NULL,
  "external_user_id" text NOT NULL,
  "deposit_wallet_address" text NOT NULL,
  "onramp_transaction_id" text NOT NULL,
  "onramp_provider" text DEFAULT 'moonpay' NOT NULL,
  "fiat_currency_code" text,
  "fiat_amount" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "granted_usd_micros" text,
  "openmeter_grant_id" text,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL,
  "settled_at" text
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_onramp_sessions_transaction_id"
  ON "onramp_sessions" ("onramp_transaction_id");

CREATE INDEX IF NOT EXISTS "idx_onramp_sessions_client_user"
  ON "onramp_sessions" ("client_id", "external_user_id");
