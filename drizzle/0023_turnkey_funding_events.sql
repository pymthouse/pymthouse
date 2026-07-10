CREATE TABLE IF NOT EXISTS "turnkey_funding_events" (
  "id" text PRIMARY KEY NOT NULL,
  "idempotency_key" text NOT NULL,
  "tx_hash" text,
  "address" text NOT NULL,
  "amount_wei" text NOT NULL,
  "funded_wei" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "error" text,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_turnkey_funding_events_idempotency_key"
  ON "turnkey_funding_events" ("idempotency_key");
