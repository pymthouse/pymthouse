ALTER TABLE "developer_apps" ADD COLUMN IF NOT EXISTS "x402_enabled" integer DEFAULT 0 NOT NULL;
ALTER TABLE "developer_apps" ADD COLUMN IF NOT EXISTS "onramp_enabled" integer DEFAULT 1 NOT NULL;
ALTER TABLE "developer_apps" ADD COLUMN IF NOT EXISTS "x402_pay_to_address" text;
ALTER TABLE "developer_apps" ADD COLUMN IF NOT EXISTS "turnkey_sub_org_id" text;
ALTER TABLE "developer_apps" ADD COLUMN IF NOT EXISTS "turnkey_wallet_id" text;

ALTER TABLE "oidc_clients" ADD COLUMN IF NOT EXISTS "deposit_wallet_address" text;

CREATE TABLE IF NOT EXISTS "x402_payments" (
  "id" text PRIMARY KEY NOT NULL,
  "client_id" text NOT NULL,
  "scheme" text DEFAULT 'exact' NOT NULL,
  "network" text NOT NULL,
  "asset" text NOT NULL,
  "from_address" text NOT NULL,
  "pay_to" text NOT NULL,
  "value_atomic" text NOT NULL,
  "nonce" text NOT NULL,
  "status" text DEFAULT 'verified' NOT NULL,
  "tx_hash" text,
  "external_user_id" text,
  "granted_usd_micros" text,
  "error_message" text,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL,
  "settled_at" text
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_x402_payments_asset_from_nonce"
  ON "x402_payments" ("asset", "from_address", "nonce");

CREATE INDEX IF NOT EXISTS "idx_x402_payments_client_id"
  ON "x402_payments" ("client_id");

CREATE TABLE IF NOT EXISTS "x402_payment_codes" (
  "id" text PRIMARY KEY NOT NULL,
  "client_id" text NOT NULL,
  "user_code" text NOT NULL,
  "device_code" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "payment_requirements" text NOT NULL,
  "payment_payload" text,
  "external_user_id" text,
  "expires_at" text NOT NULL,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL,
  "approved_at" text
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_x402_payment_codes_user_code"
  ON "x402_payment_codes" ("user_code");

CREATE UNIQUE INDEX IF NOT EXISTS "idx_x402_payment_codes_device_code"
  ON "x402_payment_codes" ("device_code");

CREATE INDEX IF NOT EXISTS "idx_x402_payment_codes_client_id"
  ON "x402_payment_codes" ("client_id");

CREATE INDEX IF NOT EXISTS "idx_x402_payment_codes_status"
  ON "x402_payment_codes" ("status");
