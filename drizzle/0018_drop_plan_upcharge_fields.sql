-- Remove unused general and pay-per-use upcharge fields from plans table.
-- Pipeline/model-specific upcharges in plan_capability_bundles are retained.

ALTER TABLE "plans" DROP COLUMN IF EXISTS "general_upcharge_percent_bps";
ALTER TABLE "plans" DROP COLUMN IF EXISTS "pay_per_use_upcharge_percent_bps";
