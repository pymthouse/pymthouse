/**
 * Seed the platform-hosted public PymtHouse app for walk-up agent x402 access.
 *
 * Env:
 *   PUBLIC_X402_APP_OWNER_ID — users.id of the platform owner (required unless an admin exists)
 *   PUBLIC_X402_CLIENT_ID — optional override (default app_pymthouse_public)
 */
import "./load-env-first";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../src/db/schema";
import { DEVICE_CODE_GRANT, DEFAULT_PUBLIC_GRANT_TYPES } from "../src/lib/oidc/grants";
import { DEFAULT_OIDC_SCOPES, ensureOpenIdScope } from "../src/lib/oidc/scopes";

const PUBLIC_CLIENT_ID =
  process.env.PUBLIC_X402_CLIENT_ID?.trim() || "app_pymthouse_public";

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error("[seed-public-x402-app] DATABASE_URL is not set.");
    process.exit(1);
  }

  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client, { schema });
  const now = new Date().toISOString();

  const existing = await db
    .select()
    .from(schema.oidcClients)
    .where(eq(schema.oidcClients.clientId, PUBLIC_CLIENT_ID))
    .limit(1);
  if (existing[0]) {
    const apps = await db
      .select()
      .from(schema.developerApps)
      .where(eq(schema.developerApps.oidcClientId, existing[0].id))
      .limit(1);
    if (apps[0]) {
      await db
        .update(schema.developerApps)
        .set({
          x402Enabled: 1,
          onrampEnabled: 1,
          marketplaceFeatured: 1,
          updatedAt: now,
        })
        .where(eq(schema.developerApps.id, apps[0].id));
      console.log(
        `[seed-public-x402-app] Updated existing public app ${PUBLIC_CLIENT_ID} (x402 enabled).`,
      );
      await client.end({ timeout: 5 });
      return;
    }
  }

  let ownerId = process.env.PUBLIC_X402_APP_OWNER_ID?.trim() || "";
  if (!ownerId) {
    const admins = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.role, "admin"))
      .limit(1);
    ownerId = admins[0]?.id || "";
  }
  if (!ownerId) {
    console.error(
      "[seed-public-x402-app] No admin user found. Set PUBLIC_X402_APP_OWNER_ID.",
    );
    await client.end({ timeout: 5 });
    process.exit(1);
  }

  const oidcRowId = randomUUID();
  const appRowId = PUBLIC_CLIENT_ID;
  const grantTypes = [
    ...DEFAULT_PUBLIC_GRANT_TYPES,
    DEVICE_CODE_GRANT,
  ].join(",");

  await db.insert(schema.oidcClients).values({
    id: oidcRowId,
    clientId: PUBLIC_CLIENT_ID,
    clientSecretHash: null,
    displayName: "PymtHouse Public",
    redirectUris: JSON.stringify([]),
    allowedScopes: ensureOpenIdScope(`${DEFAULT_OIDC_SCOPES} users:token`),
    grantTypes,
    tokenEndpointAuthMethod: "none",
    createdAt: now,
  });

  await db.insert(schema.developerApps).values({
    id: appRowId,
    ownerId,
    oidcClientId: oidcRowId,
    name: "PymtHouse Public",
    description:
      "Platform-hosted app for walk-up agents. Device-login and x402 payment codes without registering a developer app.",
    developerName: "PymtHouse",
    status: "approved",
    marketplaceFeatured: 1,
    x402Enabled: 1,
    onrampEnabled: 1,
    createdAt: now,
    updatedAt: now,
    publishedAt: now,
  });

  console.log(
    `[seed-public-x402-app] Created ${PUBLIC_CLIENT_ID} (developer_apps.id=${appRowId}).`,
  );
  await client.end({ timeout: 5 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
