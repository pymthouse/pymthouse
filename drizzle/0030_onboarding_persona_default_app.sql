ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "persona" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "onboarding_completed_at" text;--> statement-breakpoint
ALTER TABLE "developer_apps" ADD COLUMN IF NOT EXISTS "is_platform_default" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_developer_apps_platform_default"
  ON "developer_apps" ("is_platform_default")
  WHERE "is_platform_default" = 1;
