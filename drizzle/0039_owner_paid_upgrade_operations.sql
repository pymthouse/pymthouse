-- Durable Owner Paid Upgrade operations (owner + plan scoped idempotency).
-- Persist before changeKonnectSubscription; completed rows are returned on retry.

CREATE TABLE IF NOT EXISTS "owner_paid_upgrade_operations" (
  "id" text PRIMARY KEY NOT NULL,
  "idempotency_key" text NOT NULL,
  "owner_user_id" text NOT NULL,
  "plan_key" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "openmeter_subscription_id" text,
  "openmeter_plan_id" text,
  "monthly_fee_usd" text,
  "already_paid" integer DEFAULT 0 NOT NULL,
  "error" text,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_owner_paid_upgrade_operations_idempotency_key"
  ON "owner_paid_upgrade_operations" ("idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_owner_paid_upgrade_operations_owner_plan"
  ON "owner_paid_upgrade_operations" ("owner_user_id", "plan_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_owner_paid_upgrade_operations_owner_status"
  ON "owner_paid_upgrade_operations" ("owner_user_id", "status");
