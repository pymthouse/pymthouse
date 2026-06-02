-- Store compact OpenMeter feature keys on capability rows and reset stale plan sync
-- so the next sync recreates OpenMeter plans/features with keys <= 64 chars.

ALTER TABLE "plan_capability_bundles"
  ADD COLUMN IF NOT EXISTS "openmeter_feature_key" text;

-- Paid custom plans: clear OpenMeter linkage (may reference deleted OM plans or long feature keys).
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
