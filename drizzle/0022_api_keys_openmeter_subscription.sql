ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "openmeter_subscription_id" text;

CREATE INDEX IF NOT EXISTS "idx_api_keys_openmeter_subscription_id"
  ON "api_keys" ("openmeter_subscription_id")
  WHERE "openmeter_subscription_id" IS NOT NULL;
