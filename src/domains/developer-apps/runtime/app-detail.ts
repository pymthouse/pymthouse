import { DEFAULT_OIDC_SCOPES } from "@/platform/oidc/scopes";
import { billingPatternFromAllowedScopesString } from "@/platform/oidc/allowed-scopes";
import type { AuthorizedProviderApp } from "./provider-access";
import { getOidcClientByRowId, listAppAllowedDomains } from "../repo/app-oidc";

export async function readAuthorizedAppDetail(clientId: string, auth: AuthorizedProviderApp) {
  const { app } = auth;

  let clientInfo = null;
  let m2mOidcClient: {
    clientId: string;
    hasSecret: boolean;
  } | null = null;

  if (app.oidcClientId) {
    const client = await getOidcClientByRowId(app.oidcClientId);

    if (client) {
      clientInfo = {
        clientId: client.clientId,
        redirectUris: JSON.parse(client.redirectUris) as string[],
        allowedScopes: client.allowedScopes,
        grantTypes: client.grantTypes,
        tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
        hasSecret: !!client.clientSecretHash,
        postLogoutRedirectUris: client.postLogoutRedirectUris
          ? (JSON.parse(client.postLogoutRedirectUris) as string[])
          : [],
        initiateLoginUri: client.initiateLoginUri,
        deviceThirdPartyInitiateLogin: client.deviceThirdPartyInitiateLogin === 1,
        logoUri: client.logoUri,
        policyUri: client.policyUri,
        tosUri: client.tosUri,
        clientUri: client.clientUri,
      };
    }
  }

  if (app.m2mOidcClientId) {
    const m2m = await getOidcClientByRowId(app.m2mOidcClientId);
    if (m2m) {
      m2mOidcClient = {
        clientId: m2m.clientId,
        hasSecret: !!m2m.clientSecretHash,
      };
    }
  }

  const domains = await listAppAllowedDomains(app.id);

  const canonicalClientId = clientInfo?.clientId ?? clientId;
  const { oidcClientId: _oidcClientId, ...appWithoutOidcClientId } = app;
  const billingPattern = clientInfo
    ? billingPatternFromAllowedScopesString(clientInfo.allowedScopes ?? DEFAULT_OIDC_SCOPES)
    : "app_level";

  return {
    ...appWithoutOidcClientId,
    billingPattern,
    id: canonicalClientId,
    clientId: canonicalClientId,
    canSubmitForReview: auth.app.ownerId === auth.userId,
    oidcClient: clientInfo
      ? {
          ...clientInfo,
          allowedScopes: clientInfo.allowedScopes ?? DEFAULT_OIDC_SCOPES,
        }
      : null,
    m2mOidcClient,
    domains,
  };
}
