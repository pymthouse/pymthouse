--> statement-breakpoint
ALTER TABLE "plans"
  ADD COLUMN IF NOT EXISTS "discovery_policy" jsonb;

--> statement-breakpoint
ALTER TABLE "plan_capability_bundles"
  ADD COLUMN IF NOT EXISTS "discovery_policy" jsonb;
