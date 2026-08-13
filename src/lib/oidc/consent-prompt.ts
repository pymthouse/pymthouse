type GrantWithOidcScope = {
  getOIDCScope: () => string;
};

function splitScopes(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

export function requestedScopesList(
  requested: Iterable<string> | undefined,
): string[] {
  return Array.from(requested ?? [])
    .map((scope) => scope.trim())
    .filter(Boolean);
}

/**
 * Whether the authorization resume should prompt for consent.
 *
 * Honors a just-submitted `interactionResult` grant (`result.consent.grantId`)
 * as well as a grant already stored on the OIDC session. The previous check
 * only read `session.grantIdFor`, so a first-party submit of login+consent
 * still requested a new interaction — which restarts the handshake.
 */
export async function consentPromptNeeded(opts: {
  requestedScopes: Iterable<string> | undefined;
  resultConsentGrantId?: string | null;
  sessionGrantId?: string | null;
  findGrant: (
    grantId: string,
  ) => Promise<GrantWithOidcScope | null | undefined>;
}): Promise<boolean> {
  const grantId =
    opts.resultConsentGrantId?.trim() || opts.sessionGrantId?.trim();
  if (!grantId) {
    return true;
  }

  const grant = await opts.findGrant(grantId);
  if (!grant) {
    return true;
  }

  const grantedScopeSet = new Set(splitScopes(grant.getOIDCScope()));
  const requested = requestedScopesList(opts.requestedScopes);
  return !requested.every((scope) => grantedScopeSet.has(scope));
}
