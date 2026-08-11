-- Platform-scoped plans and subscriptions.
--
-- The Owner Starter plan a developer subscribes to PymtHouse on belongs to no
-- app. While these columns were NOT NULL, owner subscriptions had to borrow the
-- requesting app's Starter row, which is why the platform plan had no local
-- representation. See docs/adr-owner-vs-app-billing.md (symptom 4).
--
-- Widening only: existing rows keep their client_id, and app-scoped queries
-- filter on `client_id = <appId>`, which never matches NULL.
ALTER TABLE "plans"
  ALTER COLUMN "client_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "subscriptions"
  ALTER COLUMN "client_id" DROP NOT NULL;
--> statement-breakpoint
-- Per-owner cost-rail overrides, set by PymtHouse admins. A missing row means
-- the owner runs on platform defaults, so this table starts empty and stays
-- sparse: only owners deliberately moved off the defaults get a row.
CREATE TABLE IF NOT EXISTS "owner_billing_config" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_user_id" text NOT NULL,
  "starter_included_usd_micros" text,
  "end_user_cap" integer,
  "application_fee_bps" integer,
  "note" text,
  "updated_by" text,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "owner_billing_config"
    ADD CONSTRAINT "owner_billing_config_owner_user_id_users_id_fk"
    FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id")
    ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "owner_billing_config"
    ADD CONSTRAINT "owner_billing_config_updated_by_users_id_fk"
    FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id")
    ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_owner_billing_config_owner"
  ON "owner_billing_config" ("owner_user_id");
