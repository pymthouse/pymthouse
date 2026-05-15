--> statement-breakpoint
ALTER TABLE "developer_apps" ADD COLUMN IF NOT EXISTS "discovery_allowed_capabilities" jsonb;
