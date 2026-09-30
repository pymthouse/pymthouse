import { OIDC_SCOPES } from "./scopes";

const BACKEND_M2M_REQUIRED_SCOPES = [
  "users:token",
  "users:write",
  "device:approve",
] as const;

const BACKEND_M2M_INHERIT_FROM_PUBLIC = ["sign:job", "users:read"] as const;

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
