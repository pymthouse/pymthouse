-- Optional per-app-user preferred remote-signer discovery URL
-- (SignerSession.discovery_url) for all exchanges on behalf of that user.
ALTER TABLE "app_users"
  ADD COLUMN IF NOT EXISTS "discovery_url" text;
