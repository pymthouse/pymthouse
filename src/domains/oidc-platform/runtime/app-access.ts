import {
  getDeveloperAppAccessByOidcClientRowId,
  getOidcClientIdRowByClientId,
  hasProviderAdminAccess,
} from "../repo/app-access";

export interface AppAccessCheck {
  allowed: boolean;
  reason?: string;
  appStatus?: string;
  appName?: string;
}

export async function checkAppAccess(
  clientId: string,
  userId: string | null,
): Promise<AppAccessCheck> {
  const clientRow = await getOidcClientIdRowByClientId(clientId);
  if (!clientRow) {
    return { allowed: false, reason: "Client not found" };
  }

  const app = await getDeveloperAppAccessByOidcClientRowId(clientRow.id);
  if (!app) {
    return {
      allowed: false,
      reason: "Client is not associated with a registered developer app",
    };
  }
  if (app.status === "approved") {
    return { allowed: true, appStatus: app.status, appName: app.name };
  }
  if (!userId) {
    return {
      allowed: false,
      reason: `This app is ${app.status} and not yet available to the public`,
      appStatus: app.status,
      appName: app.name,
    };
  }
  if (app.ownerId === userId) {
    return { allowed: true, reason: "App owner", appStatus: app.status, appName: app.name };
  }

  if (await hasProviderAdminAccess(app.id, userId)) {
    return { allowed: true, reason: "App admin", appStatus: app.status, appName: app.name };
  }

  return {
    allowed: false,
    reason: `This app is ${app.status} and not yet available. Only the app owner and admins can test it before approval.`,
    appStatus: app.status,
    appName: app.name,
  };
}
