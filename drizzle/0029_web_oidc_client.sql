ALTER TABLE "developer_apps" ADD COLUMN IF NOT EXISTS "web_oidc_client_id" text;--> statement-breakpoint
DO $web_oidc$
BEGIN
  UPDATE "developer_apps" d
  SET "web_oidc_client_id" = NULL
  WHERE d."web_oidc_client_id" IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM "public"."oidc_clients" c
      WHERE c."id" = d."web_oidc_client_id"
    );

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'developer_apps_web_oidc_client_id_oidc_clients_id_fk'
  ) THEN
    ALTER TABLE "developer_apps"
      ADD CONSTRAINT "developer_apps_web_oidc_client_id_oidc_clients_id_fk"
      FOREIGN KEY ("web_oidc_client_id")
      REFERENCES "public"."oidc_clients"("id")
      ON DELETE NO ACTION
      ON UPDATE NO ACTION;
  END IF;
END
$web_oidc$;
