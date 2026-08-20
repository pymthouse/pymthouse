import type { Provider } from "oidc-provider";

import { getIssuer } from "@/lib/oidc/issuer-urls";

/** Must match `ttl.Grant` on the provider. Set on the instance so save() does not depend on `constructor.name`. */
export const OIDC_GRANT_TTL_SECONDS = 14 * 24 * 3600;

/** node-oidc-provider session.loginAccount requires a non-empty string. */
export function asOidcAccountId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const id = value.trim();
  return id.length > 0 ? id : null;
}

export function createOidcGrant(
  provider: Provider,
  clientId: string,
  accountId: string,
) {
  const grant = new provider.Grant({
    clientId,
    accountId,
  });
  // Instance TTL — not on the public Grant constructor type.
  (grant as { expiresIn: number }).expiresIn = OIDC_GRANT_TTL_SECONDS;
  return grant;
}

/**
 * Persist an OIDC grant for the requested scopes (OIDC + RFC 8707 resource).
 * Returns the grant jti for `interactionResult` consent.
 */
export async function saveOidcConsentGrant(opts: {
  provider: Provider;
  clientId: string;
  accountId: string;
  scope: string | undefined;
}): Promise<string | undefined> {
  const clientId = opts.clientId.trim();
  const accountId = opts.accountId.trim();
  const scope = opts.scope?.trim();
  if (!clientId || !accountId || !scope) {
    return undefined;
  }

  const grant = createOidcGrant(opts.provider, clientId, accountId);
  grant.addOIDCScope(scope);
  grant.addResourceScope(getIssuer(), scope);
  await grant.save();
  return grant.jti;
}
