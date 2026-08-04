-- Platform-wide Owner cost-rail defaults, editable by admins at runtime.
--
-- OPENMETER_DEFAULT_STARTER_INCLUDED_USD_MICROS remains a bootstrap fallback
-- when this row is absent. See docs/adr-owner-vs-app-billing.md.
CREATE TABLE IF NOT EXISTS "platform_billing_settings" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_starter_included_usd_micros" text NOT NULL,
  "updated_by" text,
  "updated_at" text NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "platform_billing_settings"
    ADD CONSTRAINT "platform_billing_settings_updated_by_users_id_fk"
    FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id")
    ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
