/** Browser paths that carry the OIDC interaction/resume cookie handshake. */
export function isOidcHandshakePath(pathname: string): boolean {
  return (
    pathname === "/oidc" ||
    pathname.startsWith("/oidc/") ||
    pathname === "/api/v1/oidc" ||
    pathname.startsWith("/api/v1/oidc/")
  );
}
