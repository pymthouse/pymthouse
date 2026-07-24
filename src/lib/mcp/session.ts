import "server-only";

import { createCorrelationId } from "@/lib/audit";
import { createLivepeerPythonSdkToken } from "@/lib/livepeer-python-sdk-token";
import type { McpPrincipal } from "@/lib/mcp/auth";
import { readDiscoveryServiceUrl } from "@/lib/mcp/config";
import {
  GRANT_TYPE_TOKEN_EXCHANGE,
  getSignerDiscoveryUrl,
  handleAppScopedSignerTokenExchange,
  SUBJECT_ACCESS_TOKEN_TYPE,
} from "@/lib/oidc/app-scoped-signer-token-exchange";
import { mintSignerJwtForExternalUser } from "@/lib/oidc/mint-user-signer-token";
import { buildSignerSessionEnvelope } from "@/lib/openapi/signer-session";
import type { SignerSession } from "@/lib/openapi/schemas/credentials-types";
import { getClientSignerApiUrl } from "@/lib/signer-proxy";

export type HostedSignerSession = SignerSession & {
  sdk_token?: string;
  client_id: string;
};

function attachSdkToken(
  session: SignerSession,
  principal: McpPrincipal,
): HostedSignerSession {
  const signerUrl = session.signer_url?.trim();
  let sdkToken: string | undefined;
  if (signerUrl && principal.subjectToken) {
    try {
      sdkToken = createLivepeerPythonSdkToken({
        apiKey: principal.subjectToken,
        signer: signerUrl,
        discovery:
          session.discovery_url?.trim() ||
          getSignerDiscoveryUrl() ||
          `${readDiscoveryServiceUrl()}/v1/discovery/raw?serviceType=live-runner`,
      });
    } catch {
      sdkToken = undefined;
    }
  }

  return {
    ...session,
    sdk_token: sdkToken,
    client_id: principal.publicClientId,
  };
}

/**
 * Mint a SignerSession for the authenticated MCP principal.
 * Uses the caller's credential — no platform-fixed M2M behind the MCP.
 */
export async function createSignerSessionForPrincipal(
  principal: McpPrincipal,
): Promise<HostedSignerSession> {
  if (principal.kind === "m2m") {
    const minted = await mintSignerJwtForExternalUser({
      publicClientId: principal.publicClientId,
      developerAppId: principal.developerAppId,
      externalUserId: principal.externalUserId,
    });
    const session = buildSignerSessionEnvelope({
      access_token: minted.access_token,
      expires_in: minted.expires_in,
      scope: minted.scope,
      balanceUsdMicros: minted.balanceUsdMicros,
      lifetimeGrantedUsdMicros: minted.lifetimeGrantedUsdMicros,
      signer_url: getClientSignerApiUrl(principal.publicClientId),
      discovery_url: getSignerDiscoveryUrl(),
      issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
    });
    return {
      ...session,
      client_id: principal.publicClientId,
    };
  }

  const correlationId = createCorrelationId();
  const session = await handleAppScopedSignerTokenExchange({
    publicClientId: principal.publicClientId,
    clientId: "",
    clientSecret: "",
    grantType: GRANT_TYPE_TOKEN_EXCHANGE,
    subjectToken: principal.subjectToken,
    subjectTokenType: SUBJECT_ACCESS_TOKEN_TYPE,
    requestedTokenType: SUBJECT_ACCESS_TOKEN_TYPE,
    resource: "",
    audiences: [],
    correlationId,
  });

  return attachSdkToken(session, principal);
}

export async function discoveryFetch(
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const base = readDiscoveryServiceUrl();
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discovery ${response.status}: ${body || response.statusText}`);
  }
  return response.json();
}
