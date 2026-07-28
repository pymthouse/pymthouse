/**
 * Bootstrap script: creates the first admin user, ensures the platform default
 * app for Explorers, and prints a bearer token.
 *
 * Usage:
 *   npx tsx scripts/bootstrap-admin.ts [email]
 *
 * Reads DATABASE_URL from `.env` / `.env.local` or the environment.
 * Requires a migrated database (npm run db:prepare).
 */

import "./load-env-first";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { randomBytes } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { users, sessions, signerConfig } from "../src/db/schema";
import { hashToken } from "../src/lib/token-hash";
import { closeDb } from "../src/db/index";
import { ensurePlatformDefaultApp } from "../src/lib/platform-default-app";

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error("DATABASE_URL is required.");
    process.exit(1);
  }

  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client, { schema });

  const now = new Date().toISOString();
  await db
    .insert(signerConfig)
    .values({
      id: "default",
      name: "pymthouse signer",
      network: "arbitrum-one-mainnet",
      ethRpcUrl: "https://arb1.arbitrum.io/rpc",
      signerPort: 8080,
      status: "stopped",
      defaultCutPercent: 15.0,
      billingMode: "delegated",
      createdAt: now,
    })
    .onConflictDoNothing({ target: signerConfig.id });

  const adminRows = await db.select().from(users).where(eq(users.role, "admin"));
  const email = process.argv[2] || "admin@pymthouse.local";

  function pickCanonicalAdmin(
    rows: Array<{
      id: string;
      email: string | null;
      name: string | null;
      oauthProvider: string;
      oauthSubject: string;
      createdAt: string;
    }>,
  ): string | null {
    if (rows.length === 0) return null;
    const sorted = [...rows].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    const bootstrap = sorted.find(
      (u) =>
        u.oauthProvider === "bootstrap" &&
        u.oauthSubject.startsWith("bootstrap_"),
    );
    if (bootstrap) return bootstrap.id;
    const named = sorted.find(
      (u) => u.email === email || u.name === "Bootstrap Admin",
    );
    if (named) return named.id;
    const nonTest = sorted.find(
      (u) =>
        !u.id.startsWith("user-test-") &&
        !(u.email ?? "").endsWith("@example.test"),
    );
    return nonTest?.id ?? sorted[0]?.id ?? null;
  }

  if (adminRows.length > 0) {
    console.log("\n  Admin user(s) already exist. Issuing a new token for the first admin.\n");
  }

  let userId: string;
  const existingAdminId = pickCanonicalAdmin(adminRows);
  if (existingAdminId) {
    userId = existingAdminId;
  } else {
    userId = uuidv4();
    await db.insert(users).values({
      id: userId,
      email,
      name: "Bootstrap Admin",
      oauthProvider: "bootstrap",
      oauthSubject: `bootstrap_${userId}`,
      role: "admin",
      createdAt: now,
    });
    console.log(`\n  Created admin user: ${email} (${userId})`);
  }

  try {
    const defaultApp = await ensurePlatformDefaultApp({ ownerId: userId });
    console.log(
      `\n  Platform default app: ${defaultApp.clientId}` +
        (defaultApp.created ? " (created)" : " (existing)"),
    );
  } catch (err) {
    console.warn("\n  Warning: could not ensure platform default app:", err);
  }

  const raw = randomBytes(32).toString("hex");
  const token = `pmth_${raw}`;
  const hash = hashToken(token);
  const sessionId = uuidv4();
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

  await db.insert(sessions).values({
    id: sessionId,
    userId,
    tokenHash: hash,
    scopes: "admin",
    expiresAt,
    createdAt: now,
  });

  console.log(`\n  ========================================`);
  console.log(`  pymthouse admin bearer token (admin scope)`);
  console.log(`  ========================================`);
  console.log(`\n  ${token}\n`);
  console.log(`  Expires: ${expiresAt}`);
  console.log(`  Session: ${sessionId}`);
  console.log(`\n  Use with API requests:`);
  console.log(`    curl -H "Authorization: Bearer ${token}" http://localhost:3001/api/v1/signer\n`);

  await client.end({ timeout: 5 });
  await closeDb({ timeout: 5 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
