/**
 * Canonical scope definitions — single source of truth for labels and
 * descriptions used in both the app config wizard and the consent screen.
 */

export interface ScopeDefinition {
  value: string;
  label: string;
  /** Short description shown on the consent screen and in app settings. */
  description: string;
  required?: boolean;
  /** Omitted from provider app Auth & Scopes UI; applied automatically on every public client. */
  hiddenInAppConfig?: boolean;
}

export const OPENID_SCOPE = "openid";

export const DEFAULT_OIDC_SCOPES = "openid sign:job";

/** Public app clients always include `openid`; callers must not rely on the UI to add it. */
export function ensureOpenIdScope(allowedScopes: string): string {
  const tokens = allowedScopes
    .split(/[,\s]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.includes(OPENID_SCOPE)) {
    return tokens.join(" ");
  }
  return [OPENID_SCOPE, ...tokens].join(" ");
}

export const OIDC_SCOPES: ScopeDefinition[] = [
  {
    value: OPENID_SCOPE,
    label: "OpenID",
    description: "Confirm which PymtHouse account you are signed in with",
    required: true,
    hiddenInAppConfig: true,
  },
  {
    value: "sign:mint_user_token",
    label: "Mint Signer Tokens",
    description:
      "Mint short-lived user signer JWTs for direct go-livepeer signing (M2M only)",
  },
  {
    value: "sign:job",
    label: "Sign Jobs",
    description: "Access all remote signer endpoints, including discovery and payment signing",
  },
  {
    value: "users:read",
    label: "Read Users",
    description: "Read provisioned provider-managed application users",
  },
  {
    value: "users:write",
    label: "Write Users",
    description: "Create, update, and deactivate provisioned application users",
  },
  {
    value: "users:token",
    label: "Issue User Tokens",
    description:
      "Issue app-user access tokens for provider-managed backends. Enables per-user usage attribution.",
  },
  {
    value: "device:approve",
    label: "Approve device codes",
    description:
      "RFC 8693 token exchange to bind RFC 8628 device codes after third-party login (confidential client only).",
  },
  {
    value: "admin",
    label: "Admin",
    description: "Administrative access to provider configuration surfaces",
  },
];

export const OIDC_SCOPE_MAP: Record<string, ScopeDefinition> = Object.fromEntries(
  OIDC_SCOPES.map((scope) => [scope.value, scope])
);

export function getScopeDefinition(scope: string): ScopeDefinition | undefined {
  return OIDC_SCOPE_MAP[scope];
}
