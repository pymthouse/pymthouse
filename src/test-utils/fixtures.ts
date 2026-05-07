import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db/index";
import { appUsers, developerApps, oidcClients, signerConfig, users } from "@/db/schema";
import { createAppClient, rotateClientSecret } from "@/lib/oidc/clients";
import { createSession } from "@/lib/auth";

export interface SeededDeveloperApp {
  /**
   * Public OIDC client_id and developer_apps.id (they are the same string in this
   * project, matching the POST /api/v1/apps handler which sets `appId = clientId`).
   */
  clientId: string;
  /**
   * Internal primary key of the oidc_clients row (UUID, different from clientId).
   */
  oidcClientRowId: string;
  userId: string;
  clientSecret: string;
}

export async function createTestUser(opts?: { id?: string; role?: string }): Promise<string> {
  const id = opts?.id ?? `user-test-${randomUUID()}`;
  await db.insert(users).values({
    id,
    email: `${id}@example.test`,
    name: "Test User",
    oauthProvider: "bootstrap",
    oauthSubject: id,
    role: opts?.role ?? "developer",
  });
  return id;
}

/**
 * Creates a platform user and registers teardown to delete that row. Use for
 * tests that need an extra user outside {@link cleanupTestApp} (e.g. a
 * non-owner session against another user's app).
 */
export async function createTestUserWithCleanup(
  t: Pick<TestContext, "after">,
  opts?: { id?: string; role?: string },
): Promise<string> {
  const id = await createTestUser(opts);
  t.after(async () => {
    await db.delete(users).where(eq(users.id, id));
  });
  return id;
}

export async function seedDeveloperAppWithClient(opts?: {
  status?: "draft" | "submitted" | "in_review" | "approved" | "rejected";
  ownerId?: string;
  name?: string;
}): Promise<SeededDeveloperApp> {
  const status = opts?.status ?? "approved";
  const userId = opts?.ownerId ?? (await createTestUser());
  const displayName = opts?.name ?? `Test App ${randomUUID().slice(0, 8)}`;

  const { id: oidcClientRowId, clientId } = await createAppClient(displayName);

  const clientSecret = await rotateClientSecret(clientId);
  if (!clientSecret) {
    throw new Error("Failed to rotate client secret for test fixture");
  }

  await db
    .update(oidcClients)
    .set({ tokenEndpointAuthMethod: "client_secret_post" })
    .where(eq(oidcClients.clientId, clientId));

  const now = new Date().toISOString();
  await db.insert(developerApps).values({
    id: clientId,
    ownerId: userId,
    oidcClientId: oidcClientRowId,
    name: displayName,
    status,
    createdAt: now,
    updatedAt: now,
  });

  return { clientId, oidcClientRowId, userId, clientSecret };
}

export async function createJobTokenForApp(opts: {
  userId?: string;
  endUserId?: string;
  clientId: string;
  scopes?: string;
}): Promise<string> {
  const { token } = await createSession({
    userId: opts.userId,
    endUserId: opts.endUserId,
    appId: opts.clientId,
    scopes: opts.scopes ?? "sign:job",
    expiresInDays: 1,
  });
  return token;
}

/**
 * Create a provider-managed `app_users` row alongside a matching platform
 * `users` row that shares the same primary key. This mirrors how the Usage API
 * groups `usage_records.user_id` by joining to `app_users.id`, while still
 * satisfying the FK from `sessions.user_id` so we can mint bearer tokens for
 * this user without touching the legacy `end_users` table.
 */
export async function createAppUser(opts: {
  clientId: string;
  externalUserId: string;
}): Promise<{ id: string; externalUserId: string }> {
  const id = `app-user-${randomUUID()}`;
  await createTestUser({ id });
  await db.insert(appUsers).values({
    id,
    clientId: opts.clientId,
    externalUserId: opts.externalUserId,
    status: "active",
  });
  return { id, externalUserId: opts.externalUserId };
}

/**
 * Sentinel URL the mock signer fetcher expects. Tests expose this through a
 * process-local env override so it never leaks into the shared `signer_config`
 * row that local dev and deployed instances read.
 */
export const TEST_SIGNER_URL = "http://test-signer.invalid";

function assertNonProdDatabase(): void {
  const url = process.env.DATABASE_URL ?? "";
  if (process.env.ALLOW_TEST_FIXTURES_ON_ANY_DB === "1") return;
  const looksLikeTestDb =
    /(_test|-test|\btest\b)/i.test(url) ||
    process.env.NODE_ENV === "test" ||
    process.env.CI === "true";
  if (!looksLikeTestDb) {
    throw new Error(
      "ensureRunningSigner refused to run: DATABASE_URL does not look like a test DB " +
        "(no 'test' marker, NODE_ENV!=='test', CI!=='true'). Refusing to mutate the " +
        "shared signer_config row. Set ALLOW_TEST_FIXTURES_ON_ANY_DB=1 to override.",
    );
  }
}

/**
 * Ensure the default signer row exists and is marked running so proxy routes
 * are allowed to forward requests. The mocked signer URL is process-local via
 * `PYMTHOUSE_TEST_SIGNER_URL`; do not persist it in the shared DB row.
 *
 * Teardown is intentionally a no-op: `node --test` runs files in parallel
 * **processes** sharing one Postgres row. A refcount/snapshot restore in one
 * worker would set `status` back to `stopped` while another worker's test is
 * still mid-run (503: Signer is not running). See usage-integration vs
 * proxy-routes tests.
 *
 * If an older run crashed before this fixture stopped writing signer URLs, use
 * {@link clearTestSignerSentinel} or re-seed the row.
 */
export async function ensureRunningSigner(): Promise<() => Promise<void>> {
  assertNonProdDatabase();

  const priorTestSignerUrl = process.env.PYMTHOUSE_TEST_SIGNER_URL;
  process.env.PYMTHOUSE_TEST_SIGNER_URL = TEST_SIGNER_URL;

  const rows = await db
    .select()
    .from(signerConfig)
    .where(eq(signerConfig.id, "default"))
    .limit(1);
  const prior = rows[0];

  if (prior) {
    await db
      .update(signerConfig)
      .set({
        status: "running",
        signerUrl: prior.signerUrl === TEST_SIGNER_URL ? null : prior.signerUrl,
      })
      .where(eq(signerConfig.id, "default"));
  } else {
    await db.insert(signerConfig).values({
      id: "default",
      name: "pymthouse test signer",
      status: "running",
      network: "arbitrum-one-mainnet",
      ethRpcUrl: "https://arb1.arbitrum.io/rpc",
      signerPort: 8080,
      defaultCutPercent: 15,
      billingMode: "delegated",
    });
  }

  return async () => {
    if (priorTestSignerUrl === undefined) {
      delete process.env.PYMTHOUSE_TEST_SIGNER_URL;
    } else {
      process.env.PYMTHOUSE_TEST_SIGNER_URL = priorTestSignerUrl;
    }
  };
}

/**
 * Emergency cleanup: if a previous test run crashed before teardown, wipe any
 * `test-signer.invalid` URL it left in the shared signer_config row. Safe to
 * call from CI bootstrap / a local `pnpm db:heal` style script.
 */
export async function clearTestSignerSentinel(): Promise<void> {
  await db
    .update(signerConfig)
    .set({ signerUrl: null })
    .where(
      and(
        eq(signerConfig.id, "default"),
        eq(signerConfig.signerUrl, TEST_SIGNER_URL),
      ),
    );
}

/**
 * Remove everything inserted under a seeded developer app (including the
 * oidc client row, the owner user, usage rows, and any test sessions scoped
 * to the client). Safe to call even when some of the related rows are missing.
 */
export async function cleanupTestApp(
  app: SeededDeveloperApp | undefined | null,
): Promise<void> {
  if (app == null) {
    throw new Error("cleanupTestApp: app is null or undefined");
  }
  if (typeof app.clientId !== "string" || app.clientId.trim() === "") {
    throw new Error(
      "cleanupTestApp: app.clientId must be a non-empty string (seeded developer app id / public client id)",
    );
  }
  if (typeof app.oidcClientRowId !== "string" || app.oidcClientRowId.trim() === "") {
    throw new Error(
      "cleanupTestApp: app.oidcClientRowId must be a non-empty string (oidc_clients primary key)",
    );
  }
  if (typeof app.userId !== "string" || app.userId.trim() === "") {
    throw new Error(
      "cleanupTestApp: app.userId must be a non-empty string (owner platform user id)",
    );
  }

  const appId = app.clientId;
  const oidcClientPublic = app.clientId;
  const oidcClientPk = app.oidcClientRowId;
  const ownerId = app.userId;

  // Use raw SQL (via drizzle's `sql` tag) rather than schema object references.
  // On the GitHub Actions runner, named and namespace `@/db/schema` imports
  // have intermittently produced a module with `oidcAuthCodes` (and other
  // exports) undefined inside `node --test` subprocesses under tsx, which
  // caused this teardown to crash. Raw DELETEs are immune: they do not touch
  // the schema module namespace at all, only the `db` client and plain table
  // names. Order matches the previous FK-safe sequence.
  const appUserRows = await db.execute<{ id: string }>(
    sql`SELECT id FROM app_users WHERE client_id = ${appId}`,
  );
  const appUserIds = appUserRows.map((row) => row.id);

  const endUserRows = await db.execute<{ id: string }>(
    sql`SELECT id FROM end_users WHERE app_id = ${appId}`,
  );
  const endUserIds = endUserRows.map((row) => row.id);

  await db.execute(sql`DELETE FROM sessions WHERE app_id = ${oidcClientPublic}`);
  if (appUserIds.length > 0) {
    await db.execute(
      sql`DELETE FROM sessions WHERE user_id = ANY(${sql.raw(arrayLiteral(appUserIds))})`,
    );
  }

  await deleteFromOptionalTable("oidc_auth_codes", "client_id", oidcClientPublic);
  await deleteFromOptionalTable("oidc_refresh_tokens", "client_id", oidcClientPublic);
  await deleteFromOptionalTable("oidc_device_codes", "client_id", oidcClientPublic);

  await db.execute(sql`DELETE FROM api_keys WHERE client_id = ${appId}`);
  await db.execute(sql`DELETE FROM subscriptions WHERE client_id = ${appId}`);
  await db.execute(sql`DELETE FROM plan_capability_bundles WHERE client_id = ${appId}`);
  await db.execute(sql`DELETE FROM plans WHERE client_id = ${appId}`);
  await db.execute(sql`DELETE FROM discovery_profile_bundles WHERE client_id = ${appId}`);
  await db.execute(sql`DELETE FROM discovery_profiles WHERE client_id = ${appId}`);

  await db.execute(sql`DELETE FROM usage_billing_events WHERE client_id = ${appId}`);
  await db.execute(sql`DELETE FROM usage_records WHERE client_id = ${appId}`);
  await db.execute(sql`DELETE FROM auth_audit_log WHERE client_id = ${appId}`);
  await db.execute(sql`DELETE FROM app_allowed_domains WHERE app_id = ${appId}`);

  await db.execute(sql`DELETE FROM app_users WHERE client_id = ${appId}`);
  await db.execute(sql`DELETE FROM provider_admins WHERE client_id = ${appId}`);

  // Transactions reference stream_sessions (stream_session_id FK). Remove those
  // rows before deleting stream_sessions.
  await db.execute(sql`DELETE FROM transactions WHERE client_id = ${appId}`);
  await db.execute(sql`DELETE FROM transactions WHERE app_id = ${appId}`);
  if (endUserIds.length > 0) {
    const arr = sql.raw(arrayLiteral(endUserIds));
    await db.execute(sql`DELETE FROM transactions WHERE end_user_id = ANY(${arr})`);
    await db.execute(sql`DELETE FROM stream_sessions WHERE end_user_id = ANY(${arr})`);
  }

  await db.execute(sql`DELETE FROM stream_sessions WHERE app_id = ${appId}`);
  await db.execute(sql`DELETE FROM end_users WHERE app_id = ${appId}`);

  await db.execute(sql`DELETE FROM developer_apps WHERE id = ${appId}`);
  await db.execute(sql`DELETE FROM oidc_clients WHERE id = ${oidcClientPk}`);
  if (appUserIds.length > 0) {
    await db.execute(
      sql`DELETE FROM users WHERE id = ANY(${sql.raw(arrayLiteral(appUserIds))})`,
    );
  }
  await db.execute(sql`DELETE FROM users WHERE id = ${ownerId}`);
}

/**
 * Build a Postgres text-array literal (e.g. `ARRAY['a','b']::text[]`) safely
 * from a list of strings. Ids here come from the caller's test fixture and
 * previously-inserted rows, never from untrusted input, but we still escape
 * single quotes defensively to keep the SQL well-formed.
 */
function arrayLiteral(ids: string[]): string {
  const escaped = ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
  return `ARRAY[${escaped}]::text[]`;
}

async function deleteFromOptionalTable(
  tableName: string,
  columnName: string,
  value: string,
): Promise<void> {
  await db.execute(
    sql`DELETE FROM ${sql.identifier(tableName)} WHERE ${sql.identifier(columnName)} = ${value}`,
  ).catch((err: unknown) => {
    const cause = err instanceof Error ? err.cause : undefined;
    if (
      (typeof err === "object" &&
        err !== null &&
        "code" in err &&
        err.code === "42P01") ||
      (typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        cause.code === "42P01")
    ) {
      return;
    }
    throw err;
  });
}

export function basicAuthHeader(clientId: string, clientSecret: string): string {
  return "Basic " + Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
}
