import {
  type AppBranding,
  type BrandingMode,
  getDefaultBranding,
  shouldUseWhiteLabelBranding,
  getBrandingCssVars,
} from "@/platform/oidc/branding-shared";
import {
  getDeveloperAppByAppId,
  getDeveloperAppByCustomDomain,
  getDeveloperAppByOidcClientRowId,
  getOidcClientByClientId,
} from "../repo/branding";

type BrandingAppRecord = {
  id: string;
  name: string;
  websiteUrl: string | null;
  privacyPolicyUrl: string | null;
  tosUrl: string | null;
  supportUrl: string | null;
  developerName: string | null;
  brandingMode: string | null;
  brandingLogoUrl: string | null;
  logoLightUrl: string | null;
  brandingPrimaryColor: string | null;
  brandingSupportEmail: string | null;
  customLoginEnabled: number | boolean | null;
  customLoginDomain: string | null;
  customDomainVerifiedAt: string | null;
};

export async function resolveAppBrandingByClientId(clientId: string): Promise<AppBranding> {
  const oidcClient = await getOidcClientByClientId(clientId);
  if (!oidcClient) return getDefaultBranding();

  const app = await getDeveloperAppByOidcClientRowId(oidcClient.id);

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
  const app = await getDeveloperAppByAppId(appId);
  if (!app) return getDefaultBranding();
  return resolveAppBranding(app);
}

export async function resolveAppBrandingByCustomDomain(domain: string): Promise<AppBranding | null> {
  const normalizedDomain = domain.toLowerCase().replace(/^www\./, "");
  const app = await getDeveloperAppByCustomDomain(normalizedDomain);

  if (!app || !app.customLoginEnabled || app.brandingMode !== "whiteLabel") return null;
  if (!app.customDomainVerifiedAt) return null;
  return resolveAppBranding(app);
}

function resolveAppBranding(app: BrandingAppRecord): AppBranding {
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
