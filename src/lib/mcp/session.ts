import "server-only";

import { createCorrelationId } from "@/lib/audit";
import { createLivepeerPythonSdkToken } from "@/lib/livepeer-python-sdk-token";
import type { McpPrincipal } from "@/lib/mcp/auth";
import {
  buildDiscoveryApiUrl,
  readLiveRunnerDiscoveryUrl,
} from "@/lib/mcp/config";
import {
  GRANT_TYPE_TOKEN_EXCHANGE,
  getSignerDiscoveryUrl,
  handleAppScopedSignerTokenExchange,
  SUBJECT_ACCESS_TOKEN_TYPE,
} from "@/lib/oidc/app-scoped-signer-token-exchange";
import {
  assertM2mCanMintOwnerSignJob,
  mintSignerJwtForExternalUser,
  MintUserSignerTokenError,
} from "@/lib/oidc/mint-user-signer-token";
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
        // `||` short-circuits: the discovery-service fallback is only built
        // (and only able to throw) when no signer discovery URL exists.
        discovery:
          session.discovery_url?.trim() ||
          getSignerDiscoveryUrl() ||
          readLiveRunnerDiscoveryUrl(),
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
    if (!principal.m2mClientId) {
      throw new MintUserSignerTokenError(
        "invalid_client",
        "Missing M2M client for signer session",
        401,
      );
    }
    // Parity with handleM2mOwnerSignJob: require sign:job on M2M + public clients.
    const allowed = await assertM2mCanMintOwnerSignJob(principal.m2mClientId);
    const minted = await mintSignerJwtForExternalUser({
      publicClientId: allowed.publicClientId,
      developerAppId: allowed.developerAppId,
      externalUserId: allowed.ownerId,
    });
    const session = buildSignerSessionEnvelope({
      access_token: minted.access_token,
      expires_in: minted.expires_in,
      scope: minted.scope,
      balanceUsdMicros: minted.balanceUsdMicros,
      lifetimeGrantedUsdMicros: minted.lifetimeGrantedUsdMicros,
      signer_url: getClientSignerApiUrl(allowed.publicClientId),
      discovery_url: getSignerDiscoveryUrl(),
      issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
    });
    return {
      ...session,
      client_id: allowed.publicClientId,
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
  const timeoutMs = Math.max(
    3000,
    Number.parseInt(process.env.DISCOVERY_CATALOG_REQUEST_TIMEOUT_MS ?? "15000", 10) ||
      15_000,
  );
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init?.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  const response = await fetch(buildDiscoveryApiUrl(path), {
    ...init,
    signal,
    headers: {
      Accept: "application/json",
      ...init?.headers,
    },
    cache: "no-store",
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discovery ${response.status}: ${body || response.statusText}`);
  }
  return response.json();
}
