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

/** M2M-only scope that selects the clearinghouse signer-mint token path. */
export const SIGN_MINT_USER_TOKEN_SCOPE = "sign:mint_user_token";

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
    value: "x402:settle",
    label: "Settle x402 payments",
    description:
      "Settle EIP-3009 USDC authorizations via the PymtHouse x402 facilitator (M2M only).",
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

/** Scopes that must not appear in the same token as sign:job. */
export const ADMIN_SCOPES = new Set(
  OIDC_SCOPES.map((definition) => definition.value).filter(
    (value) =>
      value !== OPENID_SCOPE &&
      value !== "sign:job" &&
      !value.startsWith("x402:"),
  ),
);

export class SignJobScopeExclusivityError extends Error {
  readonly code = "invalid_scope";

  constructor(
    message = "sign:job cannot be combined with administrative scopes in the same token",
  ) {
    super(message);
  }
}

/** Reject tokens that mix daily signing (sign:job) with administrative scopes. */
export function assertSignJobNotMixedWithAdmin(scopes: string[]): void {
  const normalized = scopes.map((scope) => scope.trim()).filter(Boolean);
  if (!normalized.includes("sign:job")) {
    return;
  }
  const conflicting = normalized.filter((scope) => ADMIN_SCOPES.has(scope));
  if (conflicting.length > 0) {
    throw new SignJobScopeExclusivityError();
  }
}

function isM2mClientId(clientId: string): boolean {
  return clientId.startsWith("m2m_");
}

const PROVIDER_EXCLUDED_SCOPES = new Set([SIGN_MINT_USER_TOKEN_SCOPE]);

const M2M_PROVIDER_EXCLUDED_SCOPES = new Set([
  SIGN_MINT_USER_TOKEN_SCOPE,
  "sign:job",
]);

/**
 * Scopes registered with node-oidc-provider for a client. Custom mint-only scopes
 * (sign:mint_user_token, M2M sign:job) stay in DB allowedScopes but are omitted here.
 */
export function toProviderScopeMetadata(
  allowedScopes: string,
  clientId: string,
): string {
  const normalized = isM2mClientId(clientId)
    ? allowedScopes
    : ensureOpenIdScope(allowedScopes);
  const excluded = isM2mClientId(clientId)
    ? M2M_PROVIDER_EXCLUDED_SCOPES
    : PROVIDER_EXCLUDED_SCOPES;
  return normalized
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean)
    .filter((scope) => !excluded.has(scope))
    .join(" ");
}
