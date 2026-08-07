CREATE TABLE IF NOT EXISTS "app_user_payment_method_checkouts" (
  "stripe_checkout_session_id" text PRIMARY KEY NOT NULL,
  "client_id" text NOT NULL REFERENCES "developer_apps"("id"),
  "external_user_id" text NOT NULL,
  "created_at" text NOT NULL DEFAULT now()::text
);

CREATE INDEX IF NOT EXISTS "idx_app_user_payment_method_checkouts_client_user"
  ON "app_user_payment_method_checkouts" ("client_id", "external_user_id");
