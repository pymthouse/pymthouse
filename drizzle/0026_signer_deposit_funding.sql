-- Fund-first deposit clearing: TicketBroker funding columns + USDC ingress + x402.

ALTER TABLE "signer_deposit_events" ADD COLUMN IF NOT EXISTS "fund_tx_hash" text;
ALTER TABLE "signer_deposit_events" ADD COLUMN IF NOT EXISTS "deposit_wei_funded" text;
ALTER TABLE "signer_deposit_events" ADD COLUMN IF NOT EXISTS "reserve_wei_funded" text;
ALTER TABLE "signer_deposit_events" ADD COLUMN IF NOT EXISTS "ingress_asset" text NOT NULL DEFAULT 'eth';
ALTER TABLE "signer_deposit_events" ADD COLUMN IF NOT EXISTS "swap_tx_hash" text;
ALTER TABLE "signer_deposit_events" ADD COLUMN IF NOT EXISTS "eth_wei_realized" text;

ALTER TABLE "developer_apps" ADD COLUMN IF NOT EXISTS "x402_builder_code" text;

CREATE TABLE IF NOT EXISTS "x402_settlements" (
  "id" text PRIMARY KEY NOT NULL,
  "authorization_nonce" text NOT NULL UNIQUE,
  "payer" text NOT NULL,
  "pay_to" text NOT NULL,
  "asset" text NOT NULL,
  "amount_raw" text NOT NULL,
  "caip2" text NOT NULL,
  "tx_hash" text,
  "builder_code" text,
  "app_id" text,
  "external_user_id" text,
  "usd_micros_credited" text,
  "status" text NOT NULL,
  "error_message" text,
  "created_at" text NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_x402_settlements_payer"
  ON "x402_settlements" ("payer");

CREATE INDEX IF NOT EXISTS "idx_x402_settlements_status"
  ON "x402_settlements" ("status");
