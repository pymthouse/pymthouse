/**
 * Repair OIDC clients for the Option 1 product model:
 *   - Public `app_*` clients never hold redirect URIs or authorization_code
 *   - Confidential `web_*` clients sync authorization_code ↔ redirect_uris
 *   - M2M `m2m_*` clients are left untouched
 *
 * When an app has both a public client with legacy redirects and a web sibling
 * with empty redirects, migrates those URIs onto the web sibling first.
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

function parseJsonArray(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((u): u is string => typeof u === "string" && u.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error("[repair-client-grants] DATABASE_URL is not set.");
    process.exit(1);
  }

  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client, { schema });

  const apps = await db.select().from(schema.developerApps);
  const clients = await db.select().from(schema.oidcClients);
  const clientsByPk = new Map(clients.map((row) => [row.id, row]));

  let fixed = 0;
  let skipped = 0;

  for (const app of apps) {
    const pub = app.oidcClientId ? clientsByPk.get(app.oidcClientId) : undefined;
    const web = app.webOidcClientId ? clientsByPk.get(app.webOidcClientId) : undefined;

    if (pub?.clientId.startsWith("app_")) {
      const pubRedirects = parseJsonArray(pub.redirectUris);
      const pubPostLogout = parseJsonArray(pub.postLogoutRedirectUris);
      const pubGrants = pub.grantTypes
        .split(",")
        .map((g) => g.trim())
        .filter(Boolean);

      if (web && pubRedirects.length > 0) {
        const webRedirects = parseJsonArray(web.redirectUris);
        if (webRedirects.length === 0) {
          const nextWebGrants = web.grantTypes
            .split(",")
            .map((g) => g.trim())
            .filter((g) => g && g !== AUTHORIZATION_CODE);
          nextWebGrants.unshift(AUTHORIZATION_CODE);
          await db
            .update(schema.oidcClients)
            .set({
              redirectUris: JSON.stringify(pubRedirects),
              grantTypes: nextWebGrants.join(","),
              ...(pubPostLogout.length > 0 && !parseJsonArray(web.postLogoutRedirectUris).length
                ? { postLogoutRedirectUris: JSON.stringify(pubPostLogout) }
                : {}),
            })
            .where(eq(schema.oidcClients.id, web.id));
          console.log(
            `[migrate] ${pub.clientId} → ${web.clientId}  redirects=${pubRedirects.length}`,
          );
          fixed++;
        }
      }

      const nextPubGrants = pubGrants.filter((g) => g !== AUTHORIZATION_CODE);
      const needsPubStrip =
        pubRedirects.length > 0 ||
        pubGrants.includes(AUTHORIZATION_CODE) ||
        (pubPostLogout.length > 0 && Boolean(web));

      if (needsPubStrip) {
        await db
          .update(schema.oidcClients)
          .set({
            redirectUris: JSON.stringify([]),
            grantTypes: nextPubGrants.join(","),
            ...(web && pubPostLogout.length > 0
              ? { postLogoutRedirectUris: JSON.stringify([]) }
              : {}),
          })
          .where(eq(schema.oidcClients.id, pub.id));
        console.log(
          `[strip]  ${pub.clientId}  cleared public redirects / authorization_code`,
        );
        fixed++;
      } else {
        skipped++;
      }
    }
  }

  for (const row of clients) {
    if (!row.clientId.startsWith("web_")) continue;

    const redirectUris = parseJsonArray(row.redirectUris);
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

    const nextGrants = needsAdd
      ? [AUTHORIZATION_CODE, ...grants.filter((g) => g !== AUTHORIZATION_CODE)]
      : grants.filter((g) => g !== AUTHORIZATION_CODE);

    console.log(
      `[web]    ${row.clientId}  redirects=${redirectUris.length}  grants: ${grants.join(",")} → ${nextGrants.join(",")}`,
    );

    await db
      .update(schema.oidcClients)
      .set({ grantTypes: nextGrants.join(",") })
      .where(eq(schema.oidcClients.clientId, row.clientId));

    fixed++;
  }

  console.log(
    `\n[repair-client-grants] Done. Fixed: ${fixed}, Skipped: ${skipped}, Clients: ${clients.length}`,
  );

  await client.end({ timeout: 5 });
}

main().catch((err) => {
  console.error("[repair-client-grants] Fatal error:", err);
  process.exit(1);
});
