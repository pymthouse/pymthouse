-- Normalize custom plan names to OpenMeter-safe characters (see plan-naming.ts).

UPDATE "plans"
SET "name" = trim(
  regexp_replace(
    regexp_replace(trim("name"), '[^A-Za-z0-9 _.\-]', ' ', 'g'),
    '\s+',
    ' ',
    'g'
  )
)
WHERE COALESCE("is_network_default", false) = false
  AND trim("name") ~ '[^A-Za-z0-9 _.\-]';

UPDATE "plans"
SET "name" = 'Plan'
WHERE COALESCE("is_network_default", false) = false
  AND (trim("name") = '' OR "name" IS NULL);

-- Clear sync again so repaired names re-publish to OpenMeter.
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
