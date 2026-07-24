ALTER TABLE "developer_apps" ADD COLUMN IF NOT EXISTS "web_oidc_client_id" text;--> statement-breakpoint
ALTER TABLE "developer_apps" ADD CONSTRAINT "developer_apps_web_oidc_client_id_oidc_clients_id_fk" FOREIGN KEY ("web_oidc_client_id") REFERENCES "public"."oidc_clients"("id") ON DELETE no action ON UPDATE no action;
