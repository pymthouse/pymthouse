ALTER TABLE "developer_apps" ADD COLUMN IF NOT EXISTS "signer_jwt_ttl_seconds" integer;

ALTER TABLE "developer_apps" ADD COLUMN IF NOT EXISTS "signer_refresh_enabled" integer DEFAULT 0 NOT NULL;

ALTER TABLE "developer_apps" ADD COLUMN IF NOT EXISTS "signer_refresh_ttl_days" integer;
