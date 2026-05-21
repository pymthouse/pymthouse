--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "is_network_default" boolean NOT NULL DEFAULT false;

--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "discovery_excluded_capabilities" jsonb;

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_plans_network_default_per_client"
  ON "plans" ("client_id")
  WHERE "is_network_default" = true;

--> statement-breakpoint
ALTER TABLE "plan_capability_bundles" DROP COLUMN IF EXISTS "sla_target_score";

--> statement-breakpoint
UPDATE "plans" p
SET
  "is_network_default" = true,
  "updated_at" = to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
WHERE p."name" = '__pymthouse_network_default__'
  AND p."is_network_default" = false
  AND NOT EXISTS (
    SELECT 1 FROM "plans" p2
    WHERE p2."client_id" = p."client_id" AND p2."is_network_default" = true
  );

--> statement-breakpoint
INSERT INTO "plans" (
  "id",
  "client_id",
  "name",
  "type",
  "price_amount",
  "price_currency",
  "status",
  "billing_cycle",
  "is_network_default",
  "discovery_excluded_capabilities",
  "created_at",
  "updated_at"
)
SELECT
  gen_random_uuid()::text,
  d."id",
  '__pymthouse_network_default__',
  'free',
  '0',
  'USD',
  'active',
  'monthly',
  true,
  NULL,
  to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM "developer_apps" d
WHERE NOT EXISTS (
  SELECT 1 FROM "plans" p
  WHERE p."client_id" = d."id" AND p."is_network_default" = true
);
