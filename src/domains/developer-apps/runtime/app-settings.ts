import { updateClientConfig } from "@/domains/oidc-platform/runtime/clients";
import { resetProvider } from "@/domains/oidc-platform/runtime/provider-instance";
import {
  extractOrigins,
  maybeAugmentAllowedScopesForDeviceFlow,
  normalizeOriginsToDomains,
  parseAppSettingsUpdate,
  validateDeviceInitiateLoginSettings,
} from "../service/app-settings";
import { ensureAppDomains } from "../repo/app-domains";
import { getOidcClientByRowId } from "../repo/app-oidc";

export async function applyAppSettingsUpdate(
  app: {
    id: string;
    oidcClientId: string | null;
    logoLightUrl: string | null;
    websiteUrl: string | null;
    privacyPolicyUrl: string | null;
    tosUrl: string | null;
  },
  body: Record<string, unknown>,
): Promise<
  | { ok: true }
  | { ok: false; status: 400 | 404; body: Record<string, unknown> }
> {
  if (!app.oidcClientId) {
    return { ok: false, status: 400, body: { error: "App has no OIDC client" } };
  }

  const client = await getOidcClientByRowId(app.oidcClientId);
  if (!client) {
    return { ok: false, status: 404, body: { error: "OIDC client not found" } };
  }

  const parsed = parseAppSettingsUpdate(body);
  const nextInitiateLoginUri =
    parsed.initiateLoginUri !== undefined ? parsed.initiateLoginUri : client.initiateLoginUri;
  const nextDeviceThirdParty =
    parsed.deviceThirdPartyInitiateLogin !== undefined
      ? parsed.deviceThirdPartyInitiateLogin
      : client.deviceThirdPartyInitiateLogin === 1;

  const validation = validateDeviceInitiateLoginSettings({
    initiateLoginUri: nextInitiateLoginUri,
    deviceThirdPartyInitiateLogin: nextDeviceThirdParty,
  });
  if (!validation.ok) {
    return {
      ok: false,
      status: 400,
      body: {
        error: validation.error,
        error_description: validation.description,
      },
    };
  }

  const clientUpdates: Parameters<typeof updateClientConfig>[1] = {
    ...parsed,
    logoUri: app.logoLightUrl || null,
    clientUri: app.websiteUrl || null,
    policyUri: app.privacyPolicyUrl || null,
    tosUri: app.tosUrl || null,
  };

  const maybeAllowedScopes = maybeAugmentAllowedScopesForDeviceFlow({
    allowedScopes: client.allowedScopes,
    grantTypes: client.grantTypes.split(",").filter(Boolean),
    initiateLoginUri: nextInitiateLoginUri,
    deviceThirdPartyInitiateLogin: nextDeviceThirdParty,
  });
  if (maybeAllowedScopes) {
    clientUpdates.allowedScopes = maybeAllowedScopes;
  }

  await updateClientConfig(client.clientId, clientUpdates);

  const allRedirects = [
    ...(parsed.redirectUris ?? (JSON.parse(client.redirectUris) as string[])),
    ...(parsed.postLogoutRedirectUris ?? []),
  ];
  const domains = normalizeOriginsToDomains(extractOrigins(allRedirects));
  await ensureAppDomains(app.id, domains);

  resetProvider();
  return { ok: true };
}
