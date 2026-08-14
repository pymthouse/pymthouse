-- Allow each developer app to retain its own registry row for a shared
-- owner wallet (bare {users.id}). The previous unique(customer_key) let the
-- last app to upsert steal the row's client_id from sibling apps.
DROP INDEX IF EXISTS "idx_billing_customers_customer_key";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_billing_customers_customer_key_client"
  ON "billing_customers" USING btree ("customer_key", "client_id");
