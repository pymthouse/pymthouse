export const PROVIDER_ENDPOINT_PATHS = {
  authorization: "/auth",
  token: "/token",
  userinfo: "/me",
  jwks: "/jwks",
  deviceAuthorization: "/device/auth",
  endSession: "/session/end",
  introspection: "/token/introspection",
  revocation: "/token/revocation",
} as const;

export const LEGACY_ROUTE_ALIASES: Record<string, string> = {
  "/authorize": PROVIDER_ENDPOINT_PATHS.authorization,
  "/userinfo": PROVIDER_ENDPOINT_PATHS.userinfo,
  "/device_authorization": PROVIDER_ENDPOINT_PATHS.deviceAuthorization,
};

export function normalizeProviderPath(path: string): string {
  return LEGACY_ROUTE_ALIASES[path] ?? path;
}
