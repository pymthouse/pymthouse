/** Reserved first-party customer-service RP. Safe to import from Client Components. */

import { ensureHttpsForProduction, getPublicOrigin } from "@/lib/oidc/issuer-urls";

export const CUSTOMER_SERVICE_OIDC_CLIENT_ID = "web_customer_service";

export const CUSTOMER_SERVICE_OIDC_DISPLAY_NAME = "Customer Service";

/**
 * Customer-service console origin. NextAuth builds `redirect_uri` from
 * `NEXTAUTH_URL`. Optional `CUSTOMER_SERVICE_URL` / `NEXT_PUBLIC_CUSTOMER_SERVICE_URL`
 * override when the console is on a different host than this issuer.
 */
export function getCustomerServiceOrigin(): string {
  const raw =
    process.env.CUSTOMER_SERVICE_URL?.trim() ||
    process.env.NEXT_PUBLIC_CUSTOMER_SERVICE_URL?.trim();
  if (raw) {
    return ensureHttpsForProduction(raw).replace(/\/+$/, "");
  }
  return getPublicOrigin();
}

export function customerServiceCallbackUri(origin?: string): string {
  const base = (origin ?? getCustomerServiceOrigin()).replace(/\/+$/, "");
  return `${base}/api/auth/callback/pymthouse`;
}

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

/** Interaction UI path; `client_id` is query-stamped so login branding survives a missing cookie. */
export function oidcInteractionPath(
  uid: string,
  clientId?: string | null,
): string {
  const params = new URLSearchParams();
  params.set("uid", uid);
  if (clientId?.trim()) {
    params.set("client_id", clientId.trim());
  }
  return `/oidc/interaction?${params.toString()}`;
}

export function isOidcReturnPath(callbackPath: string): boolean {
  return (
    callbackPath.startsWith("/oidc/interaction") ||
    callbackPath.startsWith("/oidc/consent")
  );
}

/** Full document navigation after login so the interaction RSC sees the new session cookie. */
export function resumeAfterOidcLogin(
  callbackPath: string,
  fallbackNavigate: (path: string) => void,
): void {
  if (typeof window !== "undefined" && isOidcReturnPath(callbackPath)) {
    window.location.replace(callbackPath);
    return;
  }
  fallbackNavigate(callbackPath);
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
