--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "discovery_profiles" (
  "id" text PRIMARY KEY NOT NULL,
  "client_id" text NOT NULL REFERENCES "developer_apps"("id"),
  "name" text NOT NULL,
  "policy" jsonb,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_discovery_profiles_client_name"
  ON "discovery_profiles" ("client_id", "name");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "discovery_profile_bundles" (
  "id" text PRIMARY KEY NOT NULL,
  "profile_id" text NOT NULL REFERENCES "discovery_profiles"("id") ON DELETE CASCADE,
  "client_id" text NOT NULL REFERENCES "developer_apps"("id"),
  "pipeline" text NOT NULL,
  "model_id" text NOT NULL,
  "discovery_policy" jsonb,
  "created_at" text NOT NULL
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_discovery_profile_bundles_unique"
  ON "discovery_profile_bundles" ("profile_id", "pipeline", "model_id");

--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "discovery_profile_id" text;

--> statement-breakpoint
DO $$
DECLARE
  r RECORD;
  new_profile_id text;
  plan_created text;
  plan_updated text;
BEGIN
  FOR r IN
    SELECT
      p.id AS plan_id,
      p.client_id,
      p.name AS plan_name,
      p.discovery_policy AS plan_dp,
      p.created_at AS p_created,
      p.updated_at AS p_updated
    FROM plans p
    WHERE
      p.discovery_policy IS NOT NULL
      OR EXISTS (
        SELECT 1
        FROM plan_capability_bundles b
        WHERE b.plan_id = p.id AND b.discovery_policy IS NOT NULL
      )
  LOOP
    new_profile_id := gen_random_uuid()::text;
    plan_created := r.p_created;
    plan_updated := r.p_updated;

    INSERT INTO discovery_profiles (
      id,
      client_id,
      name,
      policy,
      created_at,
      updated_at
    )
    VALUES (
      new_profile_id,
      r.client_id,
      r.plan_name || ' (discovery)',
      r.plan_dp,
      plan_created,
      plan_updated
    );

    UPDATE plans
    SET discovery_profile_id = new_profile_id
    WHERE id = r.plan_id;

    INSERT INTO discovery_profile_bundles (
      id,
      profile_id,
      client_id,
      pipeline,
      model_id,
      discovery_policy,
      created_at
    )
    SELECT
      gen_random_uuid()::text,
      new_profile_id,
      b.client_id,
      b.pipeline,
      b.model_id,
      b.discovery_policy,
      plan_created
    FROM plan_capability_bundles b
    WHERE
      b.plan_id = r.plan_id
      AND b.discovery_policy IS NOT NULL;
  END LOOP;
END $$;

--> statement-breakpoint
ALTER TABLE "plans"
  ADD CONSTRAINT "plans_discovery_profile_id_discovery_profiles_id_fk"
  FOREIGN KEY ("discovery_profile_id") REFERENCES "discovery_profiles"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

--> statement-breakpoint
ALTER TABLE "plans" DROP COLUMN IF EXISTS "discovery_policy";

--> statement-breakpoint
ALTER TABLE "plan_capability_bundles" DROP COLUMN IF EXISTS "discovery_policy";
