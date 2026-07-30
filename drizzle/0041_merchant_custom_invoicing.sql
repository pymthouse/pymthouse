ALTER TABLE "app_billing_config" ADD COLUMN IF NOT EXISTS "openmeter_merchant_billing_profile_id" text;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invoice_events" (
  "id" text PRIMARY KEY NOT NULL,
  "source" text NOT NULL,
  "external_event_id" text NOT NULL,
  "event_type" text NOT NULL,
  "payload" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" text NOT NULL,
  "claimed_by" text,
  "last_error" text,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_invoice_events_source_external"
  ON "invoice_events" ("source","external_event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_invoice_events_claim"
  ON "invoice_events" ("status","next_attempt_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "merchant_invoices" (
  "id" text PRIMARY KEY NOT NULL,
  "openmeter_invoice_id" text NOT NULL,
  "app_id" text NOT NULL,
  "openmeter_customer_id" text,
  "stripe_connected_account_id" text,
  "stripe_customer_id" text,
  "stripe_payment_intent_id" text,
  "stripe_invoice_id" text,
  "state" text NOT NULL DEFAULT 'created',
  "amount_usd_micros" text,
  "currency" text NOT NULL DEFAULT 'USD',
  "application_fee_amount" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "merchant_invoices"
    ADD CONSTRAINT "merchant_invoices_app_id_developer_apps_id_fk"
    FOREIGN KEY ("app_id") REFERENCES "public"."developer_apps"("id")
    ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_merchant_invoices_om_id"
  ON "merchant_invoices" ("openmeter_invoice_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_merchant_invoices_app"
  ON "merchant_invoices" ("app_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_merchant_invoices_pi"
  ON "merchant_invoices" ("stripe_payment_intent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_merchant_invoices_state"
  ON "merchant_invoices" ("state");
