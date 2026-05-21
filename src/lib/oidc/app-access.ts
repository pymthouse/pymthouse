/**
 * App access control for OIDC authentication.
 * 
 * Ensures that only approved apps are accessible to general users,
 * while app owners/admins can test their own apps before approval.
 */

import { db } from "@/db/index";
import { developerApps, oidcClients, providerAdmins } from "@/db/schema";
import { and, eq } from "drizzle-orm";

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
 * - Approved apps: accessible to all users
 * - Draft/submitted/in_review apps: only accessible to app owners and admins
 * - Rejected apps: only accessible to app owners and admins (for resubmission)
 */
export async function checkAppAccess(
  clientId: string,
  userId: string | null,
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

  // Get the associated developer app
  const appRows = await db
    .select({
      id: developerApps.id,
      name: developerApps.name,
      status: developerApps.status,
      ownerId: developerApps.ownerId,
    })
    .from(developerApps)
    .where(eq(developerApps.oidcClientId, oidcClientRowId))
    .limit(1);

  if (appRows.length === 0) {
    return {
      allowed: false,
      reason: "Client is not associated with a registered developer app",
    };
  }

  const app = appRows[0];

  // Approved apps are accessible to everyone
  if (app.status === "approved") {
    return {
      allowed: true,
      appStatus: app.status,
      appName: app.name,
    };
  }

  // Unauthenticated users cannot access non-approved apps
  if (!userId) {
    return {
      allowed: false,
      reason: `This app is ${app.status} and not yet available to the public`,
      appStatus: app.status,
      appName: app.name,
    };
  }

  // Check if user is the app owner
  if (app.ownerId === userId) {
    return {
      allowed: true,
      reason: "App owner",
      appStatus: app.status,
      appName: app.name,
    };
  }

  // Check if user is an admin of the app
  const adminRows = await db
    .select({ id: providerAdmins.id })
    .from(providerAdmins)
    .where(
      and(
        eq(providerAdmins.clientId, app.id),
        eq(providerAdmins.userId, userId),
      ),
    )
    .limit(1);

  if (adminRows.length > 0) {
    return {
      allowed: true,
      reason: "App admin",
      appStatus: app.status,
      appName: app.name,
    };
  }

  // User is not authorized to access this non-approved app
  return {
    allowed: false,
    reason: `This app is ${app.status} and not yet available. Only the app owner and admins can test it before approval.`,
    appStatus: app.status,
    appName: app.name,
  };
}
