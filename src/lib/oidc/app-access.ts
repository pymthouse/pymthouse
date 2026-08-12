/**
 * App access control for OIDC authentication.
 *
 * Ensures the OIDC client is associated with a registered developer app.
 * Apps are live on create — no admin approval gate.
 */

import { db } from "@/db/index";
import { developerApps, oidcClients, users } from "@/db/schema";
import { eq, or } from "drizzle-orm";
import {
  CUSTOMER_SERVICE_OIDC_DISPLAY_NAME,
  isCustomerServiceOidcClient,
} from "@/lib/oidc/customer-service-id";

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
 * - The reserved customer-service RP (`web_customer_service`) is first-party
 *   and has no developer app row
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

  if (isCustomerServiceOidcClient(clientId)) {
    if (_userId) {
      const adminRows = await db
        .select({ role: users.role })
        .from(users)
        .where(eq(users.id, _userId))
        .limit(1);
      if (adminRows[0]?.role !== "admin") {
        return {
          allowed: false,
          reason: "Customer-service login requires a platform admin account",
          appName: CUSTOMER_SERVICE_OIDC_DISPLAY_NAME,
        };
      }
    }
    return {
      allowed: true,
      appName: CUSTOMER_SERVICE_OIDC_DISPLAY_NAME,
    };
  }

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
