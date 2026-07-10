-- Repair: 0022 was dropped from drizzle journal in 9eabd14; DBs that applied
-- 0023 at when=1777900000000 skipped 0022 (when=1777800000000). Idempotent.
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "openmeter_subscription_id" text;

CREATE INDEX IF NOT EXISTS "idx_api_keys_openmeter_subscription_id"
  ON "api_keys" ("openmeter_subscription_id")
  WHERE "openmeter_subscription_id" IS NOT NULL;
