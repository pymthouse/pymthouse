type GrantWithOidcScope = {
  getOIDCScope: () => string;
  accountId?: string;
  getResourceScope?: (resource: string) => string;
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

export function promptIncludesConsent(prompt: unknown): boolean {
  if (Array.isArray(prompt)) {
    return prompt.some((value) => promptIncludesConsent(value));
  }
  if (typeof prompt !== "string") {
    return false;
  }
  return prompt.split(/\s+/).includes("consent");
}

/**
 * Whether the authorization resume should prompt for consent.
 *
 * Honors a just-submitted `interactionResult` grant (`result.consent.grantId`)
 * as well as a grant already stored on the OIDC session. The previous check
 * only read `session.grantIdFor`, so a first-party submit of login+consent
 * still requested a new interaction — which restarts the handshake.
 *
 * Claude DCR sends `prompt=consent`. Skipping that after a login-only
 * continue POST lets node-oidc-provider finish with an empty grant and redirect
 * `error=access_denied` (no description) to the loopback callback.
 */
export async function consentPromptNeeded(opts: {
  requestedScopes: Iterable<string> | undefined;
  resultConsentGrantId?: string | null;
  sessionGrantId?: string | null;
  findGrant: (
    grantId: string,
  ) => Promise<GrantWithOidcScope | null | undefined>;
  forceConsent?: boolean;
  accountId?: string | null;
  resource?: string | null;
}): Promise<boolean> {
  const resultGrantId = opts.resultConsentGrantId?.trim();
  // This authorization already accepted consent. Do not open another
  // interaction — a second prompt 303s back to /oidc/interaction and looks
  // like Authorize is reloading forever.
  if (resultGrantId) {
    return false;
  }
  if (opts.forceConsent) {
    return true;
  }

  const grantId = opts.sessionGrantId?.trim();
  if (!grantId) {
    return true;
  }

  const grant = await opts.findGrant(grantId);
  if (!grant) {
    return true;
  }
  if (
    opts.accountId &&
    grant.accountId &&
    grant.accountId !== opts.accountId
  ) {
    return true;
  }

  const grantedScopeSet = new Set(splitScopes(grant.getOIDCScope()));
  if (opts.resource && typeof grant.getResourceScope === "function") {
    for (const scope of splitScopes(grant.getResourceScope(opts.resource))) {
      grantedScopeSet.add(scope);
    }
  }
  const requested = requestedScopesList(opts.requestedScopes);
  return !requested.every((scope) => grantedScopeSet.has(scope));
}
