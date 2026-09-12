/** Tokens from a space- and/or comma-separated OIDC scopes field. */
export function parseAllowedScopes(allowedScopes: string): string[] {
  return allowedScopes
    .split(/[,\s]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

export function deriveBillingPatternFromScopes(
  tokens: string[],
): "per_user" | "app_level" {
  return tokens.includes("users:token") ? "per_user" : "app_level";
}

/** Billing mode for an app follows OIDC `allowed_scopes` (presence of `users:token`). */
export function billingPatternFromAllowedScopesString(
  allowedScopes: string,
): "per_user" | "app_level" {
  return deriveBillingPatternFromScopes(parseAllowedScopes(allowedScopes));
}
