import { eq, or } from "drizzle-orm";
import { db } from "@/db/index";
import { developerApps, oidcClients } from "@/db/schema";

export type DrizzleDb = typeof db;

/**
 * Raised when more than one `developer_apps` row matches the same OIDC client row id
 * via `developerApps.oidcClientId` or `developerApps.m2mOidcClientId` (data integrity /
 * missing uniqueness — consider a DB constraint).
 */
export class DeveloperAppSiblingAmbiguousError extends Error {
  readonly conflictingDeveloperAppIds: string[];

  constructor(conflictingDeveloperAppIds: string[]) {
    super(
      `Ambiguous developer_apps mapping for OIDC client row: expected exactly one row, found ${conflictingDeveloperAppIds.length} (ids: ${conflictingDeveloperAppIds.join(", ")}).`,
    );
    this.name = "DeveloperAppSiblingAmbiguousError";
    this.conflictingDeveloperAppIds = conflictingDeveloperAppIds;
  }
}

/**
 * Resolve the developer app and public `app_…` client_id for either the public OIDC row
 * or the paired M2M row (same pattern as device approval token exchange).
 *
 * Matches on `developerApps.oidcClientId` and `developerApps.m2mOidcClientId` — must be
 * unique per OIDC row or resolution is rejected.
 */
export async function resolveDeveloperAppAndPublicClientForOidcRow(
  dbConn: DrizzleDb,
  oidcClientRowId: string,
): Promise<{ developerAppId: string; publicClientId: string } | null> {
  const appRows = await dbConn
    .select({
      id: developerApps.id,
      oidcClientId: developerApps.oidcClientId,
    })
    .from(developerApps)
    .where(
      or(
        eq(developerApps.oidcClientId, oidcClientRowId),
        eq(developerApps.m2mOidcClientId, oidcClientRowId),
      ),
    )
    .limit(2);
  if (appRows.length === 0) return null;
  if (appRows.length > 1) {
    const ids = appRows.map((r) => r.id);
    console.error(
      "[client-sibling] multiple developer_apps rows match oidcClientRowId=%s (developerApps.oidcClientId / developerApps.m2mOidcClientId); conflicting ids=%s",
      oidcClientRowId,
      ids.join(", "),
    );
    throw new DeveloperAppSiblingAmbiguousError(ids);
  }
  const app = appRows[0];
  if (!app?.oidcClientId) return null;
  const publicRows = await dbConn
    .select({ clientId: oidcClients.clientId })
    .from(oidcClients)
    .where(eq(oidcClients.id, app.oidcClientId))
    .limit(1);
  const publicClientId = publicRows[0]?.clientId;
  if (!publicClientId) return null;
  return { developerAppId: app.id, publicClientId };
}

/**
 * After validateClientSecret: resolve public `app_…` client_id for M2M or public row.
 */
export async function resolvePublicClientIdForOidcRow(
  dbConn: DrizzleDb,
  clientRowId: string,
): Promise<string | null> {
  const ctx = await resolveDeveloperAppAndPublicClientForOidcRow(
    dbConn,
    clientRowId,
  );
  return ctx?.publicClientId ?? null;
}
