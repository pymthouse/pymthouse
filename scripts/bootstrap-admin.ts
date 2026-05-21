/**
 * Bootstrap script: creates the first admin user and prints a bearer token.
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
import { randomBytes } from "crypto";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { users, sessions, signerConfig } from "../src/db/schema";
import { hashToken } from "../src/shared/utils/token-hash";

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

  if (adminRows.length > 0) {
    console.log("\n  Admin user(s) already exist. Issuing a new token for the first admin.\n");
  }

  let userId: string;
  if (adminRows.length > 0) {
    userId = adminRows[0].id;
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

  await client.end({ timeout: 5 });

  console.log(`\n  ========================================`);
  console.log(`  pymthouse admin bearer token (admin scope)`);
  console.log(`  ========================================`);
  console.log(`\n  ${token}\n`);
  console.log(`  Expires: ${expiresAt}`);
  console.log(`  Session: ${sessionId}`);
  console.log(`\n  Use with API requests:`);
  console.log(`    curl -H "Authorization: Bearer ${token}" http://localhost:3001/api/v1/signer\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
