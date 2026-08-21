import { and, asc, eq, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "@/db/index";
import { developerApps, oidcClients, users } from "@/db/schema";
import {
  createAppClient,
  ensureM2mBackendClient,
  updateClientConfig,
} from "@/lib/oidc/clients";
import { getPlatformJwksUrlForDatabase } from "@/lib/oidc/issuer-urls";
import { DEFAULT_OIDC_SCOPES, OIDC_SCOPES } from "@/lib/oidc/scopes";
import { syncPublicClientGrantTypes } from "@/lib/oidc/grants";
import { getOrCreateNetworkDefaultPlan } from "@/lib/network-default-plan";
import { getOrCreateStarterPlan } from "@/lib/starter-default-plan";
import { resetProvider } from "@/lib/oidc/provider";

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export const PLATFORM_DEFAULT_APP_NAME = "PymtHouse App";

/** Drizzle condition: exclude the canonical platform default from catalogs. */
export function notPlatformDefaultApp() {
  return or(
    isNull(developerApps.isPlatformDefault),
    ne(developerApps.isPlatformDefault, 1),
  )!;
}

/** Optional public client_id override for the platform default app. */
export function getConfiguredDefaultAppClientId(): string | null {
  const raw = process.env.PYMTHOUSE_DEFAULT_APP_CLIENT_ID?.trim();
  return raw || null;
}

export function isPlatformDefaultAppRow(app: {
  isPlatformDefault?: number | null;
}): boolean {
  return app.isPlatformDefault === 1;
}

async function findFlaggedDefaultClientId(): Promise<string | null> {
  const rows = await db
    .select({ clientId: oidcClients.clientId })
    .from(developerApps)
    .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(eq(developerApps.isPlatformDefault, 1))
    .limit(1);
  return rows[0]?.clientId ?? null;
}

/**
 * Promote an existing developer app to the unique platform-default role and
 * keep it unpublished (internal Explorer app, not marketplace).
 */
async function promoteCanonicalDefaultApp(appId: string): Promise<void> {
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx
      .update(developerApps)
      .set({ isPlatformDefault: 0, updatedAt: now })
      .where(and(eq(developerApps.isPlatformDefault, 1), ne(developerApps.id, appId)));
    await tx
      .update(developerApps)
      .set({
        isPlatformDefault: 1,
        publishedAt: null,
        marketplaceFeatured: 0,
        updatedAt: now,
      })
      .where(eq(developerApps.id, appId));
  });
}

async function ensureDefaultAppSiblings(clientId: string): Promise<void> {
  await getOrCreateNetworkDefaultPlan(clientId, db);
  await getOrCreateStarterPlan(clientId, db);
  await ensureM2mBackendClient({
    appInternalId: clientId,
    appDisplayName: PLATFORM_DEFAULT_APP_NAME,
  });
}

/**
 * Resolve the platform default app's public client_id (`app_…`).
 * Prefers a configured override when that client exists, else the unique
 * `is_platform_default = 1` row. Read-only — does not promote or repair rows.
 */
export async function resolvePlatformDefaultClientId(): Promise<string | null> {
  const configured = getConfiguredDefaultAppClientId();
  if (configured) {
    const byEnv = await db
      .select({
        clientId: oidcClients.clientId,
      })
      .from(developerApps)
      .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
      .where(eq(oidcClients.clientId, configured))
      .limit(1);
    if (byEnv[0]?.clientId) {
      return byEnv[0].clientId;
    }
  }

  return findFlaggedDefaultClientId();
}

async function promoteConfiguredDefaultAppIfNeeded(): Promise<string | null> {
  const configured = getConfiguredDefaultAppClientId();
  if (!configured) return null;

  const byEnv = await db
    .select({
      id: developerApps.id,
      clientId: oidcClients.clientId,
      isPlatformDefault: developerApps.isPlatformDefault,
    })
    .from(developerApps)
    .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(eq(oidcClients.clientId, configured))
    .limit(1);
  const row = byEnv[0];
  if (!row?.clientId) return null;

  if (row.isPlatformDefault !== 1) {
    await promoteCanonicalDefaultApp(row.id);
  } else {
    await db
      .update(developerApps)
      .set({
        publishedAt: null,
        marketplaceFeatured: 0,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(developerApps.id, row.id));
  }
  return row.clientId;
}

export async function getPlatformDefaultApp() {
  const clientId = await resolvePlatformDefaultClientId();
  if (!clientId) return null;

  const rows = await db
    .select({
      app: developerApps,
      clientId: oidcClients.clientId,
    })
    .from(developerApps)
    .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(eq(oidcClients.clientId, clientId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Resolve the canonical platform admin for owning the platform default app.
 * Prefers `npm run bootstrap` admin, then named/email match, then non-test
 * admins, then any admin. Optional `fallbackEmail` widens the named tier
 * (bootstrap CLI passes its email arg).
 */
export async function findAdminOwnerId(
  fallbackEmail = "admin@pymthouse.local",
): Promise<string | null> {
  // Prefer the real bootstrap admin (`npm run bootstrap`), not leftover test
  // admins (createTestUser also uses oauthProvider=bootstrap).
  const bootstrap = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.role, "admin"),
        eq(users.oauthProvider, "bootstrap"),
        sql`${users.oauthSubject} like 'bootstrap_%'`,
      ),
    )
    .orderBy(asc(users.createdAt))
    .limit(1);
  if (bootstrap[0]?.id) return bootstrap[0].id;

  const named = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.role, "admin"),
        or(
          eq(users.email, fallbackEmail),
          eq(users.name, "Bootstrap Admin"),
        ),
      ),
    )
    .orderBy(asc(users.createdAt))
    .limit(1);
  if (named[0]?.id) return named[0].id;

  const nonTest = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.role, "admin"),
        sql`${users.id} not like 'user-test-%'`,
        sql`coalesce(${users.email}, '') not like '%@example.test'`,
      ),
    )
    .orderBy(asc(users.createdAt))
    .limit(1);
  if (nonTest[0]?.id) return nonTest[0].id;

  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, "admin"))
    .orderBy(asc(users.createdAt))
    .limit(1);
  return rows[0]?.id ?? null;
}

/** Prefer `preferredOwnerId` when that user is an admin; else the bootstrap admin. */
async function resolveAdminOwnerId(
  preferredOwnerId?: string,
): Promise<string | null> {
  if (preferredOwnerId) {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, preferredOwnerId), eq(users.role, "admin")))
      .limit(1);
    if (rows[0]?.id) return rows[0].id;
  }
  return findAdminOwnerId();
}

/**
 * Invariant: the platform default app must be owned by the bootstrap admin
 * (or an explicitly preferred admin). Reassigns when the current owner differs.
 */
async function ensurePlatformDefaultOwnedByAdmin(
  appId: string,
  preferredOwnerId?: string,
): Promise<void> {
  const adminId = await resolveAdminOwnerId(preferredOwnerId);
  if (!adminId) return;

  const rows = await db
    .select({ ownerId: developerApps.ownerId })
    .from(developerApps)
    .where(eq(developerApps.id, appId))
    .limit(1);
  const row = rows[0];
  if (!row || row.ownerId === adminId) return;

  await db
    .update(developerApps)
    .set({
      ownerId: adminId,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(developerApps.id, appId));
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (code === "23505" || code === 23505) return true;
  const rawMessage = (err as { message?: unknown }).message;
  const message = typeof rawMessage === "string" ? rawMessage : "";
  return /unique|duplicate key/i.test(message);
}

async function cleanupOrphanOidcClient(oidcRowId: string): Promise<void> {
  try {
    await db.delete(oidcClients).where(eq(oidcClients.id, oidcRowId));
  } catch {
    /* best-effort — winner row may already reference it in races we lost differently */
  }
}

/**
 * Ensure a single platform default app exists (owned by an admin).
 * Idempotent and race-safe against the partial unique index on
 * `is_platform_default = 1`. Safe to call from bootstrap and Explorer join.
 */
export async function ensurePlatformDefaultApp(opts?: {
  ownerId?: string;
}): Promise<{ clientId: string; created: boolean }> {
  const promoted = await promoteConfiguredDefaultAppIfNeeded();
  if (promoted) {
    await ensureDefaultAppSiblings(promoted);
    await ensurePlatformDefaultOwnedByAdmin(promoted, opts?.ownerId);
    return { clientId: promoted, created: false };
  }

  const existing = await resolvePlatformDefaultClientId();
  if (existing) {
    await ensureDefaultAppSiblings(existing);
    await db
      .update(developerApps)
      .set({
        publishedAt: null,
        marketplaceFeatured: 0,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(developerApps.id, existing));
    await ensurePlatformDefaultOwnedByAdmin(existing, opts?.ownerId);
    return { clientId: existing, created: false };
  }

  const ownerId = await resolveAdminOwnerId(opts?.ownerId);
  if (!ownerId) {
    throw new Error(
      "Cannot create platform default app: no admin user. Run npm run bootstrap first.",
    );
  }

  const { id: oidcRowId, clientId } = await createAppClient(PLATFORM_DEFAULT_APP_NAME);

  const scopesWithUserToken = [
    ...DEFAULT_OIDC_SCOPES.split(/[,\s]+/).filter(Boolean),
    "users:token",
  ]
    .filter((s, i, arr) => arr.indexOf(s) === i)
    .filter((s) => OIDC_SCOPES.some((scope) => scope.value === s))
    .join(" ");

  await updateClientConfig(clientId, {
    redirectUris: [],
    allowedScopes: scopesWithUserToken || DEFAULT_OIDC_SCOPES,
    grantTypes: syncPublicClientGrantTypes(
      ["refresh_token", DEVICE_CODE_GRANT],
      [],
      clientId,
    ),
    tokenEndpointAuthMethod: "none",
  });

  const now = new Date().toISOString();
  try {
    await db.transaction(async (tx) => {
      await tx.insert(developerApps).values({
        id: clientId,
        ownerId,
        oidcClientId: oidcRowId,
        name: PLATFORM_DEFAULT_APP_NAME,
        developerName: "PymtHouse",
        description:
          "Platform default app for Explorers. Usage and keys only — not for Builder API integrations.",
        status: "approved",
        publishedAt: null,
        jwksUri: getPlatformJwksUrlForDatabase(),
        isPlatformDefault: 1,
        createdAt: now,
        updatedAt: now,
      });
      await getOrCreateNetworkDefaultPlan(clientId, tx);
      await getOrCreateStarterPlan(clientId, tx);
    });
  } catch (err) {
    await cleanupOrphanOidcClient(oidcRowId);
    if (!isUniqueViolation(err)) throw err;

    const winner = await findFlaggedDefaultClientId();
    if (!winner) throw err;
    await ensureDefaultAppSiblings(winner);
    await ensurePlatformDefaultOwnedByAdmin(winner, opts?.ownerId);
    resetProvider();
    return { clientId: winner, created: false };
  }

  await ensureM2mBackendClient({
    appInternalId: clientId,
    appDisplayName: PLATFORM_DEFAULT_APP_NAME,
  });

  resetProvider();
  return { clientId, created: true };
}

/** True when this developer_apps id (or public client id) is the platform default. */
export async function isPlatformDefaultApp(appOrClientId: string): Promise<boolean> {
  const byFlag = await db
    .select({ id: developerApps.id })
    .from(developerApps)
    .where(
      and(
        eq(developerApps.isPlatformDefault, 1),
        eq(developerApps.id, appOrClientId),
      ),
    )
    .limit(1);
  if (byFlag[0]) return true;

  const byClient = await db
    .select({ id: developerApps.id, isPlatformDefault: developerApps.isPlatformDefault })
    .from(developerApps)
    .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(eq(oidcClients.clientId, appOrClientId))
    .limit(1);
  return byClient[0]?.isPlatformDefault === 1;
}
