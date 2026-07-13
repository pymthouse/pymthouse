ALTER TABLE "app_billing_config" ADD COLUMN IF NOT EXISTS "tax_behavior" text;
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "trial_phase_duration" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_addons" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"credit_usd_micros" text NOT NULL,
	"price_amount" text DEFAULT '0' NOT NULL,
	"price_currency" text DEFAULT 'USD' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"openmeter_addon_id" text,
	"last_synced_at" text,
	"sync_error" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_plan_overrides" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"external_user_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"notes" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_addons" ADD CONSTRAINT "billing_addons_client_id_developer_apps_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."developer_apps"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_plan_overrides" ADD CONSTRAINT "customer_plan_overrides_client_id_developer_apps_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."developer_apps"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_plan_overrides" ADD CONSTRAINT "customer_plan_overrides_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_billing_addons_client_name" ON "billing_addons" USING btree ("client_id","name");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_customer_plan_overrides_client_user" ON "customer_plan_overrides" USING btree ("client_id","external_user_id");
