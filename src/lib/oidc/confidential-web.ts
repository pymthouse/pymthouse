/**
 * Confidential web RP sibling — authorization_code + client secret + redirect
 * URIs, without client_credentials / device flow.
 *
 * Lives beside the public `app_…` client (and optional `m2m_…` helper), same
 * pattern as the M2M backend sibling.
 */

import {
  AUTHORIZATION_CODE_GRANT,
  CLIENT_CREDENTIALS_GRANT,
  DEVICE_CODE_GRANT,
  REFRESH_TOKEN_GRANT,
  parseGrantTypes,
  syncAuthorizationCodeGrant,
} from "@/lib/oidc/grants";

export const CONFIDENTIAL_WEB_AUTH_METHODS: ReadonlySet<string> = new Set([
  "client_secret_post",
  "client_secret_basic",
]);

export function isConfidentialWebAuthMethod(
  method: string | null | undefined,
): boolean {
  return Boolean(method && CONFIDENTIAL_WEB_AUTH_METHODS.has(method));
}

export function isWebClientId(clientId: string): boolean {
  return clientId.startsWith("web_");
}

/** Default grants for a newly provisioned confidential web sibling (before redirects). */
export const DEFAULT_CONFIDENTIAL_WEB_GRANT_TYPES = [
  REFRESH_TOKEN_GRANT,
] as const;

export type ConfidentialWebShapeInput = {
  tokenEndpointAuthMethod: string;
  redirectUris: string[];
  grantTypes: string[];
};

export type ConfidentialWebShapeError = {
  error: "confidential_web_invalid_shape";
  error_description: string;
};

/**
 * Validate an OIDC row intended to be the confidential web sibling.
 * Requires confidential auth method, no machine/device grants, and at least
 * one redirect URI whenever authorization_code is present (or always when
 * `requireRedirects` is true).
 */
export function validateConfidentialWebShape(
  input: ConfidentialWebShapeInput,
  options?: { requireRedirects?: boolean },
): ConfidentialWebShapeError | null {
  if (!isConfidentialWebAuthMethod(input.tokenEndpointAuthMethod)) {
    return {
      error: "confidential_web_invalid_shape",
      error_description:
        "Confidential web clients must use client_secret_post or client_secret_basic.",
    };
  }

  const redirects = input.redirectUris
    .map((u) => u.trim())
    .filter((u) => u.length > 0);
  const grants = input.grantTypes.flatMap((g) => parseGrantTypes(g));

  if (grants.includes(CLIENT_CREDENTIALS_GRANT)) {
    return {
      error: "confidential_web_invalid_shape",
      error_description:
        "Confidential web clients cannot use client_credentials. Use the M2M backend helper for machine tokens.",
    };
  }
  if (grants.includes(DEVICE_CODE_GRANT)) {
    return {
      error: "confidential_web_invalid_shape",
      error_description:
        "Confidential web clients cannot use device flow. Use the public app client for device/CLI login.",
    };
  }

  const requireRedirects =
    options?.requireRedirects === true ||
    grants.includes(AUTHORIZATION_CODE_GRANT);
  if (requireRedirects && redirects.length === 0) {
    return {
      error: "confidential_web_invalid_shape",
      error_description:
        "Confidential web clients require at least one redirect URI for authorization_code.",
    };
  }

  return null;
}

/** Strip grants that are illegal on a confidential web sibling. */
export function stripConfidentialWebIncompatibleGrants(
  grants: string[],
): string[] {
  return grants.filter(
    (g) => g !== CLIENT_CREDENTIALS_GRANT && g !== DEVICE_CODE_GRANT,
  );
}

/** Sync authorization_code ↔ redirects for a web sibling grant list. */
export function syncConfidentialWebGrantTypes(
  grants: string[],
  redirectUris: string[],
): string[] {
  return syncAuthorizationCodeGrant(
    stripConfidentialWebIncompatibleGrants(grants),
    redirectUris.length > 0,
  );
}
