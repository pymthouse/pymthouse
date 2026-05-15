--> statement-breakpoint
ALTER TABLE "developer_apps" ADD COLUMN IF NOT EXISTS "discovery_excluded_capabilities" jsonb;
