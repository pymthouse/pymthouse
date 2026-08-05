-- Multi-tier Owner Paid catalog: flat monthly fee + included usage allowance.
-- Sandbox Starter stays on platform_billing_settings; these rows are Upgrade targets.

CREATE TABLE IF NOT EXISTS "owner_subscription_tiers" (
  "id" text PRIMARY KEY NOT NULL,
  "key" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "monthly_fee_usd" text NOT NULL,
  "included_usd_micros" text NOT NULL,
  "overage_rate_usd" text,
  "sort_order" integer NOT NULL DEFAULT 0,
  "active" integer NOT NULL DEFAULT 1,
  "openmeter_plan_id" text,
  "openmeter_plan_version" integer,
  "last_synced_at" text,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_owner_subscription_tiers_key"
  ON "owner_subscription_tiers" ("key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_owner_subscription_tiers_active_sort"
  ON "owner_subscription_tiers" ("active", "sort_order");
--> statement-breakpoint
-- Seed the legacy single Paid plan as the default selectable tier.
INSERT INTO "owner_subscription_tiers" (
  "id",
  "key",
  "name",
  "description",
  "monthly_fee_usd",
  "included_usd_micros",
  "overage_rate_usd",
  "sort_order",
  "active",
  "created_at",
  "updated_at"
)
SELECT
  'ost_default_owner_paid',
  'pymthouse_owner_paid',
  'Owner Paid',
  'Monthly subscription with included network usage. Overage invoices to your card.',
  '20.00',
  '5000000',
  NULL,
  0,
  1,
  '2026-08-04T00:00:00.000Z',
  '2026-08-04T00:00:00.000Z'
WHERE NOT EXISTS (
  SELECT 1 FROM "owner_subscription_tiers" WHERE "key" = 'pymthouse_owner_paid'
);
