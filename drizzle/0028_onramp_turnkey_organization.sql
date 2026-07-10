ALTER TABLE "onramp_sessions"
  ADD COLUMN IF NOT EXISTS "turnkey_organization_id" text;
