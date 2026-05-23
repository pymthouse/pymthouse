-- Repair databases whose drizzle migration metadata got ahead of 0017.
-- Keep this idempotent so fresh databases can safely run both 0017 and 0018.
ALTER TABLE "developer_apps" ADD COLUMN IF NOT EXISTS "signing_mode" text NOT NULL DEFAULT 'legacy_remote_signer';
ALTER TABLE "developer_apps" ADD COLUMN IF NOT EXISTS "payer_daemon_socket" text;

