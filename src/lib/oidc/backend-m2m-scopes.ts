import { OIDC_SCOPES, SIGN_MINT_USER_TOKEN_SCOPE } from "@/lib/oidc/scopes";

/** Always granted on the confidential backend helper (Builder + device approval). */
const BACKEND_M2M_REQUIRED_SCOPES = [
  "users:token",
  "users:write",
  "device:approve",
  "x402:settle",
] as const;

/** Copied from the public app when present so M2M tokens can call matching APIs (e.g. signer). */
const BACKEND_M2M_INHERIT_FROM_PUBLIC = ["sign:job", "users:read"] as const;

/**
 * Allowed scopes for the `m2m_` backend helper: fixed Builder/device scopes plus
 * `sign:job` / `users:read` when the public OIDC client has those scopes enabled.
 */
export function computeBackendM2mAllowedScopes(publicAllowedScopes: string): string {
  const publicSet = new Set(
    publicAllowedScopes
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const selected = new Set<string>([...BACKEND_M2M_REQUIRED_SCOPES]);
  for (const scope of BACKEND_M2M_INHERIT_FROM_PUBLIC) {
    if (publicSet.has(scope)) {
      selected.add(scope);
    }
  }
  if (publicSet.has("sign:job")) {
    selected.add(SIGN_MINT_USER_TOKEN_SCOPE);
  }
  const ordered = OIDC_SCOPES.map((d) => d.value).filter((v) => selected.has(v));
  return ordered.join(" ");
}

/** Mint-only scopes — not issued via node-oidc-provider client_credentials. */
const CLIENT_CREDENTIALS_EXCLUDED_SCOPES = new Set([
  SIGN_MINT_USER_TOKEN_SCOPE,
  "sign:job",
]);

/**
 * Scopes for a standard `client_credentials` machine token request (Builder admin).
 * `sign:mint_user_token` and `sign:job` are excluded — those use custom mint paths.
 */
export function scopeForClientCredentialsRequest(scopes: string): string {
  return scopes
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((scope) => !CLIENT_CREDENTIALS_EXCLUDED_SCOPES.has(scope))
    .join(" ");
}

/** Backend-helper scopes suitable for the Testing tab client_credentials curl. */
export function computeBackendM2mClientCredentialsScopes(
  publicAllowedScopes: string,
): string {
  return scopeForClientCredentialsRequest(
    computeBackendM2mAllowedScopes(publicAllowedScopes),
  );
}

/** True when the public app client allows remote signer access. */
export function publicAppAllowsSignJob(publicAllowedScopes: string): boolean {
  return publicAllowedScopes
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .includes("sign:job");
}
