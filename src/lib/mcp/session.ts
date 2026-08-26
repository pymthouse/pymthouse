import "server-only";

import { hasScope } from "@/lib/auth";
import { createCorrelationId } from "@/lib/audit";
import { buildAppManifestForApp } from "@/lib/app-manifest";
import type { AppManifestResponse } from "@/lib/discovery-allowlist";
import {
  resolvePlansDiscoveryForApp,
  type ResolvedPlanRow,
} from "@/lib/discovery-profile-resolve";
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
  if (signerUrl && session.access_token) {
    try {
      sdkToken = createLivepeerPythonSdkToken({
        // The signer verifies the OIDC audience, so the SDK token has to carry
        // the freshly minted sign:job access_token — not the caller's MCP
        // bearer, whose audience is the MCP endpoint.
        apiKey: session.access_token,
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
  if (principal.kind === "mcp_oauth") {
    if (!hasScope(principal.scope ?? "", "sign:job")) {
      throw new MintUserSignerTokenError(
        "invalid_grant",
        "MCP access token must include sign:job to create a signer session",
        403,
      );
    }
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
    return attachSdkToken(session, principal);
  }

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

type CacheEntry<T> = {
  expiresAt: number;
  value: T;
};

const manifestCache = new Map<string, CacheEntry<AppManifestResponse>>();
const plansCache = new Map<string, CacheEntry<ResolvedPlanRow[]>>();
const discoveryGetCache = new Map<string, CacheEntry<unknown>>();

const MANIFEST_TTL_MS = 30_000;
const PLANS_TTL_MS = 30_000;

function readCache<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function writeCache<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  value: T,
  ttlMs: number,
): T {
  cache.set(key, { expiresAt: Date.now() + ttlMs, value });
  return value;
}

export async function cachedAppManifestForApp(
  developerAppId: string,
): Promise<AppManifestResponse> {
  const cached = readCache(manifestCache, developerAppId);
  if (cached) return cached;
  const value = await buildAppManifestForApp(developerAppId);
  return writeCache(manifestCache, developerAppId, value, MANIFEST_TTL_MS);
}

export async function cachedPlansDiscoveryForApp(
  developerAppId: string,
): Promise<ResolvedPlanRow[]> {
  const cached = readCache(plansCache, developerAppId);
  if (cached) return cached;
  const value = await resolvePlansDiscoveryForApp(developerAppId);
  return writeCache(plansCache, developerAppId, value, PLANS_TTL_MS);
}

export async function discoveryFetch(
  path: string,
  init?: RequestInit,
  options?: { cacheTtlMs?: number },
): Promise<unknown> {
  const method = (init?.method ?? "GET").toUpperCase();
  const cacheTtlMs = options?.cacheTtlMs ?? 0;
  const cacheKey = `${method}:${path}`;
  if (method === "GET" && cacheTtlMs > 0) {
    const cached = readCache(discoveryGetCache, cacheKey);
    if (cached !== undefined) return cached;
  }

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
  const data = await response.json();
  if (method === "GET" && cacheTtlMs > 0) {
    writeCache(discoveryGetCache, cacheKey, data, cacheTtlMs);
  }
  return data;
}
