import { randomBytes } from "crypto";
import { v4 as uuidv4 } from "uuid";
import { SignJWT } from "jose";
import { ensureSigningKey } from "@/domains/oidc-platform/runtime/jwks";
import { getIssuer } from "@/platform/oidc/issuer-urls";
import { billingPatternFromAllowedScopesString } from "@/platform/oidc/allowed-scopes";
import {
  consumeSessionByIdAndToken,
  createSession,
  validateBearerToken,
} from "@/domains/identity-access/runtime/request-auth";
import {
  getActiveAppUserForRefresh,
  getProgrammaticTokenAppPolicy,
  getProgrammaticTokenBinding,
  getRefreshTokenProgrammaticApp,
} from "../repo/programmatic-tokens";
import { validateClientSecret } from "./clients";

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_DAYS = 30;

export class ProgrammaticTokenError extends Error {
  code: string;
  constructor(code: string, message: string) {
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
  const app = await getProgrammaticTokenAppPolicy(input.developerAppId);
  if (!app) throw new ProgrammaticTokenError("invalid_client", "App not found");

  if (billingPatternFromAllowedScopesString(app.allowedScopes) !== "per_user") {
    throw new ProgrammaticTokenError(
      "invalid_request",
      "Programmatic user tokens require the users:token scope on the OAuth client",
    );
  }

  const binding = await getProgrammaticTokenBinding(input);
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
  if (!input.clientId || !input.clientSecret) return null;

  const appUserId = session.label.replace("app_user_refresh:", "");
  const app = await getRefreshTokenProgrammaticApp(session.appId);

  if (!app || billingPatternFromAllowedScopesString(app.allowedScopes) !== "per_user") {
    return null;
  }
  if (input.clientId !== app.oauthClientId) return null;
  if (!(await validateClientSecret(input.clientId, input.clientSecret))) return null;

  const appUser = await getActiveAppUserForRefresh(appUserId, app.appId);
  if (!appUser || appUser.status !== "active") return null;

  const consumed = await consumeSessionByIdAndToken(session.sessionId, input.refreshToken);
  if (!consumed) return null;

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
