-- Shared state for headless agent registration (multi-instance safe).
CREATE TABLE IF NOT EXISTS "network_agent_challenges" (
  "challenge_id" text PRIMARY KEY NOT NULL,
  "fingerprint" text NOT NULL,
  "nonce" text NOT NULL,
  "expires_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "network_agent_challenges_fingerprint_idx"
  ON "network_agent_challenges" ("fingerprint");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "network_agent_challenges_expires_idx"
  ON "network_agent_challenges" ("expires_at_ms");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "network_agent_rate_buckets" (
  "bucket_key" text PRIMARY KEY NOT NULL,
  "count" integer NOT NULL,
  "reset_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "network_agent_rate_buckets_reset_idx"
  ON "network_agent_rate_buckets" ("reset_at_ms");
