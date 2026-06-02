-- Replace wei/bps pricing with USD retail rates for OpenMeter plan sync.

ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "overage_rate_usd" text;

UPDATE "plans"
SET "overage_rate_usd" = '0.000001'
WHERE "overage_rate_usd" IS NULL;

ALTER TABLE "plan_capability_bundles" ADD COLUMN IF NOT EXISTS "retail_rate_usd" text;

-- Convert legacy bps markup to retail $/micro (base network = $0.000001 per USD-micro).
UPDATE "plan_capability_bundles"
SET "retail_rate_usd" = (
  0.000001 * (1 + COALESCE("upcharge_percent_bps", 0)::numeric / 10000)
)::text
WHERE "retail_rate_usd" IS NULL
  AND "upcharge_percent_bps" IS NOT NULL
  AND "upcharge_percent_bps" > 0;

ALTER TABLE "plan_capability_bundles" DROP COLUMN IF EXISTS "upcharge_percent_bps";

ALTER TABLE "plans" DROP COLUMN IF EXISTS "overage_rate_wei";
