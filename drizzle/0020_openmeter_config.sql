CREATE TABLE IF NOT EXISTS "app_openmeter_config" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"mode" text DEFAULT 'pymthouse_hosted' NOT NULL,
	"base_url" text,
	"api_key_encrypted" text,
	"meter_slug" text DEFAULT 'network_fee_usd_micros' NOT NULL,
	"trial_feature_key" text DEFAULT 'network_spend' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_app_openmeter_config_client_id" ON "app_openmeter_config" USING btree ("client_id");
--> statement-breakpoint
ALTER TABLE "app_openmeter_config" ADD CONSTRAINT "app_openmeter_config_client_id_developer_apps_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."developer_apps"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_ingest_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"request_id" text NOT NULL,
	"openmeter_event_id" text NOT NULL,
	"external_user_id" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_usage_ingest_receipts_client_request" ON "usage_ingest_receipts" USING btree ("client_id","request_id");
--> statement-breakpoint
ALTER TABLE "usage_ingest_receipts" ADD CONSTRAINT "usage_ingest_receipts_client_id_developer_apps_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."developer_apps"("id") ON DELETE no action ON UPDATE no action;
