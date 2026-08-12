/** Reserved first-party customer-service RP. Safe to import from Client Components. */

export const CUSTOMER_SERVICE_OIDC_CLIENT_ID = "web_customer_service";

export const CUSTOMER_SERVICE_OIDC_DISPLAY_NAME = "Customer Service";

export const DEFAULT_CUSTOMER_SERVICE_ORIGIN = "http://localhost:3010";

export function getCustomerServiceOidcClientId(): string {
  return process.env.CS_OIDC_CLIENT_ID?.trim() || CUSTOMER_SERVICE_OIDC_CLIENT_ID;
}

export function isCustomerServiceOidcClient(
  clientId: string | null | undefined,
): boolean {
  const id = clientId?.trim();
  if (!id) return false;
  return (
    id === CUSTOMER_SERVICE_OIDC_CLIENT_ID ||
    id === getCustomerServiceOidcClientId()
  );
}

/** Admins sign in on `/login/admin`; Builder/Explorer OIDC stays on `/login`. */
export function oidcLoginPathForClient(
  clientId: string | null | undefined,
): "/login/admin" | "/login" {
  return isCustomerServiceOidcClient(clientId) ? "/login/admin" : "/login";
}

export function oidcLoginRedirect(
  clientId: string | null | undefined,
  callbackPath: string,
): string {
  const params = new URLSearchParams();
  params.set("callbackUrl", callbackPath);
  if (clientId?.trim()) {
    params.set("client_id", clientId.trim());
  }
  return `${oidcLoginPathForClient(clientId)}?${params.toString()}`;
}
