import { eq } from "drizzle-orm";
import { db } from "@/db/index";
import { developerApps, oidcClients } from "@/db/schema";
import {
  consumeSessionByIdAndToken,
  validateBearerToken,
} from "@/lib/auth";
import { validateClientSecret } from "@/lib/oidc/clients";
import {
  mintSignerJwtForExternalUser,
  SIGNER_REFRESH_LABEL_PREFIX,
} from "@/lib/oidc/mint-user-signer-token";

/**
 * Parse a `signer_refresh:{developerAppId}:{externalUserId}` session label.
 * `externalUserId` may itself contain colons, so only the first segment after
 * the prefix is treated as the app id.
 */
export function parseSignerRefreshLabel(
  label: string,
): { developerAppId: string; externalUserId: string } | null {
  if (!label.startsWith(SIGNER_REFRESH_LABEL_PREFIX)) {
    return null;
  }
  const rest = label.slice(SIGNER_REFRESH_LABEL_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0 || sep >= rest.length - 1) {
    return null;
  }
  return {
    developerAppId: rest.slice(0, sep),
    externalUserId: rest.slice(sep + 1),
  };
}

/**
 * Rotate a signer-JWT refresh token: validate the `signer_refresh` session,
 * authenticate the developer app's M2M client, consume + rotate the session,
 * and re-mint a signer JWT (which re-checks billing allowance and issues a new
 * refresh token). Returns `null` when the request is not a signer-refresh
 * rotation so the caller can fall through to other refresh handlers.
 */
export async function rotateSignerRefreshToken(input: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}) {
  const session = await validateBearerToken(input.refreshToken);
  if (!session?.label || !session.appId) {
    return null;
  }
  const parsed = parseSignerRefreshLabel(session.label);
  if (!parsed) {
    return null;
  }

  if (!input.clientId || !input.clientSecret) {
    return null;
  }

  const appRows = await db
    .select({
      appId: developerApps.id,
      publicClientId: oidcClients.clientId,
      m2mOidcClientId: developerApps.m2mOidcClientId,
      signerRefreshEnabled: developerApps.signerRefreshEnabled,
    })
    .from(developerApps)
    .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(eq(developerApps.id, parsed.developerAppId))
    .limit(1);
  const app = appRows[0];
  if (!app || !app.signerRefreshEnabled) {
    return null;
  }

  // The session is bound to the public client id; reject mismatched sessions.
  if (session.appId !== app.publicClientId) {
    return null;
  }

  // The refresher authenticates as the developer app's confidential M2M client.
  const m2mRows = app.m2mOidcClientId
    ? await db
        .select({ clientId: oidcClients.clientId })
        .from(oidcClients)
        .where(eq(oidcClients.id, app.m2mOidcClientId))
        .limit(1)
    : [];
  const m2mClientId = m2mRows[0]?.clientId;
  if (!m2mClientId || input.clientId !== m2mClientId) {
    return null;
  }
  if (!(await validateClientSecret(input.clientId, input.clientSecret))) {
    return null;
  }

  const consumed = await consumeSessionByIdAndToken(
    session.sessionId,
    input.refreshToken,
  );
  if (!consumed) {
    return null;
  }

  return mintSignerJwtForExternalUser({
    publicClientId: app.publicClientId,
    developerAppId: app.appId,
    externalUserId: parsed.externalUserId,
  });
}
