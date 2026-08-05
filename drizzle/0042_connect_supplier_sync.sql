ALTER TABLE "app_billing_config" ADD COLUMN IF NOT EXISTS "supplier_country" text;--> statement-breakpoint
ALTER TABLE "app_billing_config" ADD COLUMN IF NOT EXISTS "supplier_name" text;--> statement-breakpoint
ALTER TABLE "app_billing_config" ADD COLUMN IF NOT EXISTS "supplier_business_type" text;--> statement-breakpoint
ALTER TABLE "app_billing_config" ADD COLUMN IF NOT EXISTS "supplier_address_line1" text;--> statement-breakpoint
ALTER TABLE "app_billing_config" ADD COLUMN IF NOT EXISTS "supplier_address_line2" text;--> statement-breakpoint
ALTER TABLE "app_billing_config" ADD COLUMN IF NOT EXISTS "supplier_address_city" text;--> statement-breakpoint
ALTER TABLE "app_billing_config" ADD COLUMN IF NOT EXISTS "supplier_address_state" text;--> statement-breakpoint
ALTER TABLE "app_billing_config" ADD COLUMN IF NOT EXISTS "supplier_address_postal_code" text;--> statement-breakpoint
ALTER TABLE "app_billing_config" ADD COLUMN IF NOT EXISTS "supplier_tax_id" text;--> statement-breakpoint
ALTER TABLE "app_billing_config" ADD COLUMN IF NOT EXISTS "supplier_tax_id_on_file_at_stripe" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app_billing_config" ADD COLUMN IF NOT EXISTS "supplier_synced_at" text;
