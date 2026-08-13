/**
 * Bootstrap script: creates the first admin user, ensures the platform default
 * app for Explorers, ensures the customer-service OIDC RP, and prints a bearer
 * token.
 *
 * Usage:
 *   npx tsx scripts/bootstrap-admin.ts [email] [--rotate-secret]
 *
 * Reads DATABASE_URL from `.env` / `.env.local` or the environment.
 * Requires a migrated database (npm run db:prepare).
 *
 * Customer-service RP env: CS_OIDC_CLIENT_ID, CS_OIDC_REDIRECT_URI,
 * CUSTOMER_SERVICE_URL / NEXT_PUBLIC_CUSTOMER_SERVICE_URL.
 * Pass --rotate-secret to mint a new CS client secret (written to
 * .env.customer-service-oidc, not stdout).
 */

import "./load-env-first";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { v4 as uuidv4 } from "uuid";
import * as schema from "../src/db/schema";
import { users, sessions, signerConfig } from "../src/db/schema";
import { hashToken } from "../src/lib/token-hash";
import { closeDb } from "../src/db/index";
import {
  ensurePlatformDefaultApp,
  findAdminOwnerId,
} from "../src/lib/platform-default-app";
import { ensureCustomerServiceOidcClient } from "../src/lib/oidc/customer-service-client";
import {
  CUSTOMER_SERVICE_OIDC_ENV_FILENAME,
  writeCustomerServiceOidcEnvFile,
} from "../src/lib/oidc/customer-service-oidc-env";
import { getIssuer, getPublicOrigin } from "../src/lib/oidc/issuer-urls";

function parseBootstrapArgs(argv: string[]): {
  email: string;
  rotateSecret: boolean;
} {
  const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  return {
    email: positional[0] || "admin@pymthouse.local",
    rotateSecret: flags.has("--rotate-secret"),
  };
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error("DATABASE_URL is required.");
    process.exit(1);
  }
  const { email, rotateSecret } = parseBootstrapArgs(process.argv.slice(2));

  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client, { schema });

  try {
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

    const existingAdminId = await findAdminOwnerId(email);

    if (existingAdminId) {
      console.log("\n  Admin user(s) already exist. Issuing a new token for the canonical admin.\n");
    }

    let userId: string;
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

    try {
      const cs = await ensureCustomerServiceOidcClient({ rotateSecret });
      const status = cs.created
        ? "created"
        : cs.secretRotated
          ? "existing, secret rotated"
          : "existing";
      console.log(`\n  Customer-service OIDC client: ${cs.clientId} (${status})`);
      console.log(`  Redirects: ${cs.redirectUris.join(", ")}`);
      if (cs.clientSecret) {
        const envPath = resolve(CUSTOMER_SERVICE_OIDC_ENV_FILENAME);
        writeCustomerServiceOidcEnvFile(envPath, {
          issuer: getIssuer(),
          apiBaseUrl: getPublicOrigin(),
          clientId: cs.clientId,
          clientSecret: cs.clientSecret,
          redirectUri: cs.redirectUris[0] ?? "",
        });
        console.log(`\n  Wrote CS OIDC credentials to ${envPath} (mode 600)`);
        console.log(
          "  Copy into customer-service .env — do not commit or paste the secret into logs.",
        );
      } else {
        console.log(
          "  Secret unchanged (pass --rotate-secret to mint a new one).",
        );
      }
    } catch (err) {
      console.warn("\n  Warning: could not ensure customer-service OIDC client:", err);
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
  } finally {
    await client.end({ timeout: 5 });
    await closeDb({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
