import { OIDC_SCOPES } from "@/lib/oidc/scopes";

/** Always granted on the confidential backend helper (Builder + device approval). */
const BACKEND_M2M_REQUIRED_SCOPES = [
  "users:token",
  "users:write",
  "device:approve",
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
  const ordered = OIDC_SCOPES.map((d) => d.value).filter((v) => selected.has(v));
  return ordered.join(" ");
}
