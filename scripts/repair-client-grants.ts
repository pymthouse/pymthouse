/**
 * Repair grant_types for all public (app_*) OIDC clients to enforce the
 * authorization_code ↔ redirect_uris invariant.
 *
 * Rule:
 *   - Client has redirect URIs  → authorization_code MUST be in grant_types
 *   - Client has no redirect URIs → authorization_code MUST NOT be in grant_types
 *
 * M2M clients (m2m_*) are left untouched.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/repair-client-grants.ts
 *   or:
 *   npx tsx scripts/repair-client-grants.ts  (loads from .env.local via load-env-first)
 */
import "./load-env-first";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";

const AUTHORIZATION_CODE = "authorization_code";

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error("[repair-client-grants] DATABASE_URL is not set.");
    process.exit(1);
  }

  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client, { schema });

  const rows = await db.select().from(schema.oidcClients);

  let fixed = 0;
  let skipped = 0;

  for (const row of rows) {
    // Skip M2M clients — they never use redirect URIs or authorization_code.
    if (row.clientId.startsWith("m2m_")) {
      skipped++;
      continue;
    }

    const redirectUris: string[] = JSON.parse(row.redirectUris ?? "[]");
    const grants = row.grantTypes
      .split(",")
      .map((g) => g.trim())
      .filter(Boolean);

    const hasRedirects = redirectUris.length > 0;
    const hasAuthCode = grants.includes(AUTHORIZATION_CODE);

    const needsAdd = hasRedirects && !hasAuthCode;
    const needsRemove = !hasRedirects && hasAuthCode;

    if (!needsAdd && !needsRemove) {
      skipped++;
      continue;
    }

    let nextGrants: string[];
    if (needsAdd) {
      nextGrants = [AUTHORIZATION_CODE, ...grants];
      console.log(
        `[add]    ${row.clientId}  redirects=${redirectUris.length}  grants: ${grants.join(",")} → ${nextGrants.join(",")}`,
      );
    } else {
      nextGrants = grants.filter((g) => g !== AUTHORIZATION_CODE);
      console.log(
        `[remove] ${row.clientId}  no redirects  grants: ${grants.join(",")} → ${nextGrants.join(",")}`,
      );
    }

    await db
      .update(schema.oidcClients)
      .set({ grantTypes: nextGrants.join(",") })
      .where(eq(schema.oidcClients.clientId, row.clientId));

    fixed++;
  }

  console.log(
    `\n[repair-client-grants] Done. Fixed: ${fixed}, Skipped: ${skipped}, Total: ${rows.length}`,
  );

  await client.end({ timeout: 5 });
}

main().catch((err) => {
  console.error("[repair-client-grants] Fatal error:", err);
  process.exit(1);
});
