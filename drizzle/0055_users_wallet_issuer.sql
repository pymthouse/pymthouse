-- Wallet-issuer login remembers which Turnkey sub-org a PymtHouse user owns,
-- and when that sub-org accepted the PymtHouse OIDC provider.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "turnkey_sub_org_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "wallet_linked_at" text;
