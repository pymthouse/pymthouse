-- Repair: 0021_drop_legacy_usage_tables was skipped on some branches where
-- later migrations already advanced drizzle.__drizzle_migrations.created_at.
-- Idempotent; safe if tables are already gone.
DROP TABLE IF EXISTS "usage_billing_events";
DROP TABLE IF EXISTS "usage_records";
