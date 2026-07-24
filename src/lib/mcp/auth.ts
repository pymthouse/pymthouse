import "server-only";

import { authenticateAppClient } from "@/lib/auth";
import { resolveActiveAppApiKeyByBearer } from "@/lib/app-api-keys";
import { authenticateEndUser } from "@/lib/auth/end-user";
import { extractBearerToken } from "@/lib/mcp/config";
import {
  resolveSubjectAccessToken,
  SubjectAccessTokenResolveError,
} from "@/lib/oidc/resolve-subject-access-token";
import { getProviderAppByClientId } from "@/lib/provider-apps";

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
    const app = await getProviderAppByClientId(m2m.appId);
    if (!app) {
      return null;
    }
    return {
      kind: "m2m",
      publicClientId: m2m.appId,
      developerAppId: app.id,
      externalUserId: app.ownerId,
      subjectToken: "",
    };
  }

  let bearer: string;
  try {
    bearer = extractBearerToken(request.headers.get("authorization"));
  } catch {
    return null;
  }

  const apiKey = await resolveActiveAppApiKeyByBearer(bearer);
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
