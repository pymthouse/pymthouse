ALTER TABLE "developer_apps" ADD COLUMN IF NOT EXISTS "signing_mode" text NOT NULL DEFAULT 'legacy_remote_signer';
ALTER TABLE "developer_apps" ADD COLUMN IF NOT EXISTS "payer_daemon_socket" text;
