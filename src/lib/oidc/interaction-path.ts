/**
 * Same-origin POST target for login / consent. GET must never complete an
 * interaction — that would be a cookie-less top-level CSRF.
 */
export function oidcInteractionSubmitPath(uid: string): string {
  return `/api/v1/oidc/interaction/${encodeURIComponent(uid)}`;
}
