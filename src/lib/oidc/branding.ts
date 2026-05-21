import { db } from "@/db/index";
import { developerApps, oidcClients } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  type AppBranding,
  type BrandingMode,
  getDefaultBranding,
  shouldUseWhiteLabelBranding,
  getBrandingCssVars,
} from "./branding-shared";

export async function resolveAppBrandingByClientId(clientId: string): Promise<AppBranding> {
  const oidcRows = await db
    .select()
    .from(oidcClients)
    .where(eq(oidcClients.clientId, clientId))
    .limit(1);
  const oidcClient = oidcRows[0];

  if (!oidcClient) {
    return getDefaultBranding();
  }

  const appRows = await db
    .select()
    .from(developerApps)
    .where(eq(developerApps.oidcClientId, oidcClient.id))
    .limit(1);
  const app = appRows[0];

  if (!app) {
    return {
      ...getDefaultBranding(),
      displayName: oidcClient.displayName,
      logoUrl: oidcClient.logoUri || null,
    };
  }

  return resolveAppBranding(app);
}

export async function resolveAppBrandingByAppId(appId: string): Promise<AppBranding> {
  const appRows = await db
    .select()
    .from(developerApps)
    .where(eq(developerApps.id, appId))
    .limit(1);
  const app = appRows[0];

  if (!app) {
    return getDefaultBranding();
  }

  return resolveAppBranding(app);
}

export async function resolveAppBrandingByCustomDomain(
  domain: string,
): Promise<AppBranding | null> {
  const normalizedDomain = domain.toLowerCase().replace(/^www\./, "");

  const appRows = await db
    .select()
    .from(developerApps)
    .where(eq(developerApps.customLoginDomain, normalizedDomain))
    .limit(1);
  const app = appRows[0];

  if (!app || !app.customLoginEnabled || app.brandingMode !== "whiteLabel") {
    return null;
  }

  if (!app.customDomainVerifiedAt) {
    return null;
  }

  return resolveAppBranding(app);
}

function resolveAppBranding(app: typeof developerApps.$inferSelect): AppBranding {
  const brandingMode = (app.brandingMode as BrandingMode) || "blackLabel";

  if (brandingMode === "blackLabel") {
    return {
      mode: "blackLabel",
      appId: app.id,
      appName: app.name,
      displayName: "pymthouse",
      logoUrl: null,
      primaryColor: "#10b981",
      websiteUrl: app.websiteUrl,
      privacyPolicyUrl: app.privacyPolicyUrl,
      tosUrl: app.tosUrl,
      supportUrl: app.supportUrl,
      supportEmail: null,
      developerName: app.developerName,
      customLoginDomain: null,
      customLoginEnabled: false,
    };
  }

  return {
    mode: "whiteLabel",
    appId: app.id,
    appName: app.name,
    displayName: app.name,
    logoUrl: app.brandingLogoUrl || app.logoLightUrl || null,
    primaryColor: app.brandingPrimaryColor || "#10b981",
    websiteUrl: app.websiteUrl,
    privacyPolicyUrl: app.privacyPolicyUrl,
    tosUrl: app.tosUrl,
    supportUrl: app.supportUrl,
    supportEmail: app.brandingSupportEmail || null,
    developerName: app.developerName,
    customLoginDomain: app.customLoginEnabled ? app.customLoginDomain : null,
    customLoginEnabled: Boolean(app.customLoginEnabled),
  };
}
export { getDefaultBranding, shouldUseWhiteLabelBranding, getBrandingCssVars };
export type { AppBranding, BrandingMode };
