/**
 * App access control for OIDC authentication.
 *
 * Ensures the OIDC client is associated with a registered developer app.
 * Apps are live on create — no admin approval gate.
 */

import { db } from "@/db/index";
import { developerApps, oidcClients } from "@/db/schema";
import { eq, or } from "drizzle-orm";

export interface AppAccessCheck {
  allowed: boolean;
  reason?: string;
  appStatus?: string;
  appName?: string;
}

/**
 * Check if a user can authenticate to an app via OIDC.
 *
 * Rules:
 * - Registered developer apps are accessible to all users
 * - Unknown / unregistered clients are blocked
 * - Public `app_`, M2M `m2m_`, and confidential web `web_` siblings all resolve
 *   to the same developer app
 */
export async function checkAppAccess(
  clientId: string,
  _userId: string | null,
): Promise<AppAccessCheck> {
  // Get the OIDC client
  const clientRows = await db
    .select({ id: oidcClients.id })
    .from(oidcClients)
    .where(eq(oidcClients.clientId, clientId))
    .limit(1);

  if (clientRows.length === 0) {
    return {
      allowed: false,
      reason: "Client not found",
    };
  }

  const oidcClientRowId = clientRows[0].id;

  // Public row or confidential sibling (m2m_ / web_) → same developer app
  const appRows = await db
    .select({
      id: developerApps.id,
      name: developerApps.name,
      status: developerApps.status,
    })
    .from(developerApps)
    .where(
      or(
        eq(developerApps.oidcClientId, oidcClientRowId),
        eq(developerApps.m2mOidcClientId, oidcClientRowId),
        eq(developerApps.webOidcClientId, oidcClientRowId),
      ),
    )
    .limit(1);

  if (appRows.length === 0) {
    return {
      allowed: false,
      reason: "Client is not associated with a registered developer app",
    };
  }

  const app = appRows[0];

  return {
    allowed: true,
    appStatus: app.status,
    appName: app.name,
  };
}
