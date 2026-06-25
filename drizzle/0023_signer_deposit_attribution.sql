-- Shared-signer deposit attribution: wallet uniqueness, turnkey sub-org ids, deposit event log.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "turnkey_sub_org_id" text;

ALTER TABLE "end_users" ADD COLUMN IF NOT EXISTS "turnkey_sub_org_id" text;

-- Lowercase existing wallet addresses before unique indexes.
UPDATE "users"
SET "wallet_address" = lower(trim("wallet_address"))
WHERE "wallet_address" IS NOT NULL
  AND "wallet_address" <> lower(trim("wallet_address"));

UPDATE "end_users"
SET "wallet_address" = lower(trim("wallet_address"))
WHERE "wallet_address" IS NOT NULL
  AND "wallet_address" <> lower(trim("wallet_address"));

CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_wallet_address"
  ON "users" ("wallet_address")
  WHERE "wallet_address" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_end_users_wallet_address"
  ON "end_users" ("wallet_address")
  WHERE "wallet_address" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "signer_deposit_events" (
  "id" text PRIMARY KEY NOT NULL,
  "idempotency_key" text NOT NULL UNIQUE,
  "tx_hash" text,
  "from_address" text,
  "amount_wei" text NOT NULL,
  "eth_usd_price" text,
  "usd_micros_credited" text,
  "app_id" text,
  "external_user_id" text,
  "status" text NOT NULL,
  "error_message" text,
  "created_at" text NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_signer_deposit_events_tx_hash"
  ON "signer_deposit_events" ("tx_hash");

CREATE INDEX IF NOT EXISTS "idx_signer_deposit_events_from_address"
  ON "signer_deposit_events" ("from_address");

CREATE INDEX IF NOT EXISTS "idx_signer_deposit_events_status"
  ON "signer_deposit_events" ("status");
