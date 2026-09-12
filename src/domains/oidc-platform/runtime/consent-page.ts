import type { AppBranding } from "@/platform/oidc/branding-shared";
import {
  getConsentClientMetadataByClientId,
  getConsentDeveloperAppByOidcClientRowId,
} from "../repo/consent-page";

export async function getConsentDisplayData(params: {
  clientId: string;
  oidcClientRowId: string;
  branding: AppBranding;
}) {
  const [developerApp, oidcClientRow] = await Promise.all([
    getConsentDeveloperAppByOidcClientRowId(params.oidcClientRowId),
    getConsentClientMetadataByClientId(params.clientId),
  ]);

  const logoUrl =
    params.branding.mode === "whiteLabel"
      ? params.branding.logoUrl || oidcClientRow?.logoUri || developerApp?.logoLightUrl || null
      : oidcClientRow?.logoUri || developerApp?.logoLightUrl || null;

  return {
    developerApp,
    logoUrl,
  };
}
