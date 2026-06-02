ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "app_user_id" text;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "key_prefix" text;

DO $$ BEGIN
  ALTER TABLE "api_keys"
    ADD CONSTRAINT "api_keys_app_user_id_app_users_id_fk"
    FOREIGN KEY ("app_user_id") REFERENCES "public"."app_users"("id")
    ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "idx_api_keys_app_user_id" ON "api_keys" ("app_user_id");
