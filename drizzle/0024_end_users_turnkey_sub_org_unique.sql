ALTER TABLE "end_users" ADD COLUMN IF NOT EXISTS "turnkey_sub_org_id" text;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_end_users_turnkey_sub_org_id" ON "end_users" USING btree ("turnkey_sub_org_id") WHERE "turnkey_sub_org_id" IS NOT NULL;
