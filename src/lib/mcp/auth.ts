import "server-only";

import { resolveActiveAppApiKeyFromBearer } from "@/lib/app-api-keys";
import { authenticateAppClient } from "@/lib/auth";
import { authenticateEndUser } from "@/lib/auth/end-user";
import { extractBearerToken } from "@/lib/mcp/config";
import {
  resolveSubjectAccessToken,
  SubjectAccessTokenResolveError,
} from "@/lib/oidc/resolve-subject-access-token";
import { resolveLinkedM2mApp } from "@/lib/oidc/mint-user-signer-token";

export type McpPrincipal = {
  /** How the caller authenticated to Livepeer MCP. */
  kind: "api_key" | "jwt" | "m2m";
  publicClientId: string;
  developerAppId: string;
  externalUserId: string;
  /**
   * Bearer subject for RFC 8693 exchange (API key / user JWT).
   * Empty for M2M Basic — session mint uses owner identity directly.
   */
  subjectToken: string;
  /**
   * Authenticating M2M client id (`m2m_…`). Present only when `kind === "m2m"`.
   * Used to enforce `sign:job` before minting owner signer sessions.
   */
  m2mClientId?: string;
};

/**
 * Resolve the authenticated Livepeer MCP principal.
 * Accepts end-user / developer Bearer (API key or JWT), or M2M Basic credentials.
 * Does not use platform-fixed M2M env behind the MCP.
 */
export async function resolveMcpPrincipal(
  request: Request,
): Promise<McpPrincipal | null> {
  const m2m = await authenticateAppClient(request);
  if (m2m) {
    // Confidential-web (`web_`) clients must not mint owner signer sessions via MCP.
    // Mirror OIDC M2M policy: Basic auth is restricted to linked `m2m_*` clients.
    if (!m2m.clientId.startsWith("m2m_")) {
      return null;
    }
    const linked = await resolveLinkedM2mApp(m2m.clientId);
    if (!linked) {
      return null;
    }
    return {
      kind: "m2m",
      publicClientId: linked.publicClientId,
      developerAppId: linked.developerAppId,
      externalUserId: linked.ownerId,
      subjectToken: "",
      m2mClientId: m2m.clientId,
    };
  }

  let bearer: string;
  try {
    bearer = extractBearerToken(request.headers.get("authorization"));
  } catch {
    return null;
  }

  const apiKey = await resolveActiveAppApiKeyFromBearer(bearer);
  if (apiKey) {
    return {
      kind: "api_key",
      publicClientId: apiKey.publicClientId,
      developerAppId: apiKey.developerAppId,
      externalUserId: apiKey.externalUserId,
      subjectToken: bearer,
    };
  }

  const endUser = await authenticateEndUser(request);
  if (endUser) {
    return {
      kind: "jwt",
      publicClientId: endUser.publicClientId,
      developerAppId: endUser.developerAppId,
      externalUserId: endUser.externalUserId,
      subjectToken: bearer,
    };
  }

  try {
    const resolved = await resolveSubjectAccessToken(bearer);
    return {
      kind: "jwt",
      publicClientId: resolved.publicClientId,
      developerAppId: resolved.developerAppId,
      externalUserId: resolved.externalUserId,
      subjectToken: bearer,
    };
  } catch (err) {
    if (err instanceof SubjectAccessTokenResolveError) {
      return null;
    }
    throw err;
  }
}
