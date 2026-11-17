--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "is_network_default" boolean NOT NULL DEFAULT false;

--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "discovery_excluded_capabilities" jsonb;

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_plans_network_default_per_client"
  ON "plans" ("client_id")
  WHERE "is_network_default";

--> statement-breakpoint
ALTER TABLE "plan_capability_bundles" DROP COLUMN IF EXISTS "sla_target_score";

--> statement-breakpoint
DO $migrate$
DECLARE
  ts_fmt constant text := 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';
  net_name constant text := '__pymthouse_network_default__';
BEGIN
  UPDATE "plans" p
  SET
    "is_network_default" = true,
    "updated_at" = to_char((now() AT TIME ZONE 'utc'), ts_fmt)
  WHERE p."name" = net_name
    AND NOT p."is_network_default"
    AND p."client_id" NOT IN (
      SELECT p2."client_id" FROM "plans" p2 WHERE p2."is_network_default"
    );

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
    net_name,
    'free',
    '0',
    'USD',
    'active',
    'monthly',
    true,
    NULL,
    to_char((now() AT TIME ZONE 'utc'), ts_fmt),
    to_char((now() AT TIME ZONE 'utc'), ts_fmt)
  FROM "developer_apps" d
  WHERE d."id" NOT IN (
    SELECT p."client_id" FROM "plans" p WHERE p."is_network_default"
  );
END
$migrate$;
