-- Per-app Starter plan (free tier via OpenMeter subscription entitlements).

--> statement-breakpoint
ALTER TABLE "plans"
  ADD COLUMN IF NOT EXISTS "is_starter_default" boolean DEFAULT false NOT NULL;

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_plans_starter_default_per_client"
  ON "plans" ("client_id")
  WHERE "is_starter_default" = true;

--> statement-breakpoint
INSERT INTO "plans" (
  "id",
  "client_id",
  "name",
  "type",
  "price_amount",
  "price_currency",
  "status",
  "included_usd_micros",
  "billing_cycle",
  "is_network_default",
  "is_starter_default",
  "created_at",
  "updated_at"
)
SELECT
  gen_random_uuid()::text,
  p."client_id",
  '__pymthouse_starter__',
  'usage',
  '0',
  'USD',
  'active',
  '5000000',
  'monthly',
  false,
  true,
  to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM "plans" p
WHERE p."is_network_default" = true
  AND NOT EXISTS (
    SELECT 1
    FROM "plans" s
    WHERE s."client_id" = p."client_id"
      AND s."is_starter_default" = true
  );
