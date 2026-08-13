import type { KoaContextWithOIDC } from "oidc-provider";

/**
 * Resolve a prior grant without throwing. Generic Errors here become
 * `server_error` / "oops! something went wrong" on the RP redirect.
 */
export async function loadExistingGrant(ctx: KoaContextWithOIDC) {
  const clientId = ctx.oidc.client?.clientId;
  const grantId =
    ctx.oidc.result?.consent?.grantId ||
    (clientId ? ctx.oidc.session?.grantIdFor(clientId) : undefined);

  if (!grantId) {
    return undefined;
  }

  const grant = await ctx.oidc.provider.Grant.find(grantId);
  if (!grant) {
    return undefined;
  }

  const accountId = ctx.oidc.account?.accountId;
  if (accountId && grant.accountId !== accountId) {
    return undefined;
  }
  if (clientId && grant.clientId !== clientId) {
    return undefined;
  }

  return grant;
}
