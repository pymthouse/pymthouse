import { randomBytes } from "crypto";
import { v4 as uuidv4 } from "uuid";
import { SignJWT } from "jose";
import { ensureSigningKey } from "@/lib/oidc/jwks";
import { getIssuer } from "@/lib/oidc/issuer-urls";
import {
  consumeSessionByIdAndToken,
  createSession,
  validateBearerToken,
} from "@/lib/auth";
import { db } from "@/db/index";
import { appUsers, developerApps, oidcClients } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { validateClientSecret } from "./clients";
import { billingPatternFromAllowedScopesString } from "@/lib/allowed-scopes";

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_DAYS = 30;

export class ProgrammaticTokenError extends Error {
  code: string;
  constructor(
    code: string,
    message: string,
  ) {
    super(message);
    this.code = code;
  }
}

export async function issueProgrammaticTokens(input: {
  developerAppId: string;
  oauthClientId: string;
  appUserId: string;
  scopes: string[];
}) {
  const appRows = await db
    .select({ allowedScopes: oidcClients.allowedScopes })
    .from(developerApps)
    .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(eq(developerApps.id, input.developerAppId))
    .limit(1);
  const app = appRows[0];

  if (!app) {
    throw new ProgrammaticTokenError("invalid_client", "App not found");
  }

  if (billingPatternFromAllowedScopesString(app.allowedScopes) !== "per_user") {
    throw new ProgrammaticTokenError(
      "invalid_request",
      "Programmatic user tokens require the users:token scope on the OAuth client",
    );
  }

  const bindingRows = await db
    .select({
      oauthClientId: oidcClients.clientId,
      appUserId: appUsers.id,
    })
    .from(developerApps)
    .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .innerJoin(
      appUsers,
      and(eq(appUsers.clientId, developerApps.id), eq(appUsers.id, input.appUserId)),
    )
    .where(
      and(
        eq(developerApps.id, input.developerAppId),
        eq(oidcClients.clientId, input.oauthClientId),
        eq(appUsers.status, "active"),
      ),
    )
    .limit(1);
  const binding = bindingRows[0];
  if (!binding) {
    throw new ProgrammaticTokenError(
      "invalid_client",
      "OAuth client, app, and app user are not bound as expected",
    );
  }

  const issuer = getIssuer();
  const keyPair = await ensureSigningKey();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const scope = input.scopes.join(" ").trim();

  const accessToken = await new SignJWT({
    scope,
    scp: input.scopes,
    client_id: binding.oauthClientId,
    user_type: "app_user",
  })
    .setProtectedHeader({ alg: "RS256", kid: keyPair.kid, typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(issuer)
    .setSubject(binding.appUserId)
    .setJti(uuidv4())
    .setIssuedAt(nowSeconds)
    .setNotBefore(nowSeconds)
    .setExpirationTime(nowSeconds + ACCESS_TOKEN_TTL_SECONDS)
    .sign(keyPair.privateKey);

  const refresh = await createSession({
    appId: binding.oauthClientId,
    label: `app_user_refresh:${binding.appUserId}`,
    scopes: scope,
    expiresInDays: REFRESH_TOKEN_TTL_DAYS,
  });

  return {
    access_token: accessToken,
    refresh_token: refresh.token,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    scope,
    subject_type: "app_user",
  };
}

export async function rotateProgrammaticRefreshToken(input: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}) {
  const session = await validateBearerToken(input.refreshToken);
  if (!session?.label?.startsWith("app_user_refresh:") || !session.appId) {
    return null;
  }

  if (!input.clientId || !input.clientSecret) {
    return null;
  }

  const appUserId = session.label.replace("app_user_refresh:", "");
  const appRows = await db
    .select({
      appId: developerApps.id,
      oauthClientId: oidcClients.clientId,
      allowedScopes: oidcClients.allowedScopes,
    })
    .from(developerApps)
    .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(eq(oidcClients.clientId, session.appId))
    .limit(1);
  const app = appRows[0];

  if (
    !app ||
    billingPatternFromAllowedScopesString(app.allowedScopes) !== "per_user"
  ) {
    return null;
  }

  if (input.clientId !== app.oauthClientId) {
    return null;
  }

  if (!(await validateClientSecret(input.clientId, input.clientSecret))) {
    return null;
  }

  const appUserRows = await db
    .select()
    .from(appUsers)
    .where(
      and(
        eq(appUsers.id, appUserId),
        eq(appUsers.clientId, app.appId),
      ),
    )
    .limit(1);
  const appUser = appUserRows[0];

  if (!appUser || appUser.status !== "active") {
    return null;
  }

  const consumed = await consumeSessionByIdAndToken(
    session.sessionId,
    input.refreshToken,
  );
  if (!consumed) {
    return null;
  }

  return issueProgrammaticTokens({
    developerAppId: app.appId,
    oauthClientId: app.oauthClientId,
    appUserId: appUser.id,
    scopes: session.scopes.split(/[\s,]+/).map((scope) => scope.trim()).filter(Boolean),
  });
}

export function generateApiKeyValue() {
  return `pmth_${randomBytes(32).toString("hex")}`;
}
