CREATE TABLE IF NOT EXISTS "billing_customers" (
  "id" text PRIMARY KEY NOT NULL,
  "customer_key" text NOT NULL,
  "kind" text NOT NULL,
  "platform_user_id" text,
  "end_user_id" text,
  "client_id" text NOT NULL,
  "openmeter_customer_id" text NOT NULL,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_customers" ADD CONSTRAINT "billing_customers_end_user_id_end_users_id_fk" FOREIGN KEY ("end_user_id") REFERENCES "public"."end_users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_customers" ADD CONSTRAINT "billing_customers_client_id_developer_apps_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."developer_apps"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_billing_customers_customer_key" ON "billing_customers" USING btree ("customer_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_billing_customers_client_id" ON "billing_customers" USING btree ("client_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_billing_customers_openmeter_id" ON "billing_customers" USING btree ("openmeter_customer_id");
