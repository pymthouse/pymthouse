import { normalizeDomainWhitelist } from "@/shared/utils/domain-whitelist";
import { validateInitiateLoginUri } from "@/platform/oidc/third-party-initiate-login";

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const TOKEN_ENDPOINT_AUTH_METHODS = [
  "none",
  "client_secret_post",
  "client_secret_basic",
] as const;
type TokenEndpointAuthMethod = (typeof TOKEN_ENDPOINT_AUTH_METHODS)[number];

type Ok<T> = { ok: true; value: T };
type Err = { ok: false; error: string; description?: string };

export interface ParsedAppSettingsUpdate {
  redirectUris?: string[];
  postLogoutRedirectUris?: string[];
  initiateLoginUri?: string | null;
  deviceThirdPartyInitiateLogin?: boolean;
  tokenEndpointAuthMethod?: TokenEndpointAuthMethod;
}

export function extractOrigins(uris: string[]): string[] {
  const origins = new Set<string>();
  for (const uri of uris) {
    try {
      const url = new URL(uri);
      origins.add(url.origin);
    } catch {
      /* skip malformed URIs */
    }
  }
  return Array.from(origins);
}

export function parseAppSettingsUpdate(body: Record<string, unknown>): ParsedAppSettingsUpdate {
  const updates: ParsedAppSettingsUpdate = {};
  if (Array.isArray(body.redirectUris)) updates.redirectUris = body.redirectUris as string[];
  if (Array.isArray(body.postLogoutRedirectUris)) {
    updates.postLogoutRedirectUris = body.postLogoutRedirectUris as string[];
  }
  if (body.initiateLoginUri !== undefined) {
    updates.initiateLoginUri = (body.initiateLoginUri as string) || null;
  }
  if (body.deviceThirdPartyInitiateLogin !== undefined) {
    updates.deviceThirdPartyInitiateLogin = Boolean(body.deviceThirdPartyInitiateLogin);
  }
  if (body.tokenEndpointAuthMethod !== undefined) {
    const method = String(body.tokenEndpointAuthMethod) as TokenEndpointAuthMethod;
    if (TOKEN_ENDPOINT_AUTH_METHODS.includes(method)) {
      updates.tokenEndpointAuthMethod = method;
    }
  }
  return updates;
}

export function validateDeviceInitiateLoginSettings(params: {
  initiateLoginUri: string | null;
  deviceThirdPartyInitiateLogin: boolean;
}): Ok<true> | Err {
  if (!params.deviceThirdPartyInitiateLogin) {
    return { ok: true, value: true };
  }
  const uri = params.initiateLoginUri?.trim();
  if (!uri) {
    return {
      ok: false,
      error: "invalid_request",
      description:
        "Initiate login URI is required when device third-party login is enabled",
    };
  }
  try {
    validateInitiateLoginUri(uri);
  } catch {
    return {
      ok: false,
      error: "invalid_request",
      description:
        "Initiate login URI must be a valid HTTPS URL (HTTP on localhost allowed in development)",
    };
  }
  return { ok: true, value: true };
}

export function maybeAugmentAllowedScopesForDeviceFlow(params: {
  allowedScopes: string;
  grantTypes: string[];
  initiateLoginUri: string | null;
  deviceThirdPartyInitiateLogin: boolean;
}): string | null {
  if (!params.deviceThirdPartyInitiateLogin || !params.initiateLoginUri?.trim()) {
    return null;
  }
  if (!params.grantTypes.includes(DEVICE_CODE_GRANT)) {
    return null;
  }
  const allowedScopes = params.allowedScopes.split(/[,\s]+/).filter(Boolean);
  if (allowedScopes.includes("users:token")) {
    return null;
  }
  return [...allowedScopes, "users:token"].join(" ");
}

export function normalizeOriginsToDomains(origins: string[]): string[] {
  const domains: string[] = [];
  for (const origin of origins) {
    const result = normalizeDomainWhitelist(origin);
    if (!result.success) continue;
    domains.push(result.normalized);
  }
  return domains;
}
