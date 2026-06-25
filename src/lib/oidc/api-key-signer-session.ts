import { resolveActiveAppApiKey } from "@/lib/app-api-keys";
import {
  ApiKeyCredentialError,
  parseAppApiKeyBearer,
  parseScopeList,
} from "@/lib/openapi/api-key";
import { buildSignerSessionEnvelope, resolvePublicSignerUrl } from "@/lib/openapi/signer-session";
import {
  issueProgrammaticTokens,
  ProgrammaticTokenError,
} from "@/lib/oidc/programmatic-tokens";
import { resolveSubjectAccessToken, SubjectAccessTokenResolveError } from "@/lib/oidc/resolve-subject-access-token";
import { mintSignerJwtForExternalUser } from "@/lib/oidc/mint-user-signer-token";
import type { SignerSession } from "@/lib/openapi/schemas/credentials-types";

const ISSUED_ACCESS_TOKEN_TYPE =
  "urn:ietf:params:oauth:token-type:access_token";

export class ApiKeySignerSessionError extends Error {
  code: string;
  status: number;

  constructor(
    code: string,
    message: string,
    status = 400,
  ) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export async function mintSignerSessionFromAppApiKey(input: {
  apiKey: string;
  publicClientId: string;
  scope?: string;
}): Promise<SignerSession> {
  let apiKey: string;
  try {
    apiKey = parseAppApiKeyBearer(input.apiKey);
  } catch (err) {
    if (err instanceof ApiKeyCredentialError) {
      throw new ApiKeySignerSessionError(err.code, err.message, err.status);
    }
    throw err;
  }

  const resolved = await resolveActiveAppApiKey(apiKey, input.publicClientId);
  if (!resolved) {
    throw new ApiKeySignerSessionError(
      "invalid_client",
      "invalid or revoked API key",
      401,
    );
  }

  const scopes = parseScopeList(input.scope);

  let userTokens;
  try {
    userTokens = await issueProgrammaticTokens({
      developerAppId: resolved.developerAppId,
      oauthClientId: resolved.publicClientId,
      appUserId: resolved.appUserId,
      scopes,
    });
  } catch (err) {
    if (err instanceof ProgrammaticTokenError) {
      throw new ApiKeySignerSessionError(err.code, err.message, 400);
    }
    throw err;
  }

  let subject;
  try {
    subject = await resolveSubjectAccessToken(userTokens.access_token, {
      expectedPublicClientId: resolved.publicClientId,
    });
  } catch (err) {
    if (err instanceof SubjectAccessTokenResolveError) {
      throw new ApiKeySignerSessionError(err.code, err.message, err.status);
    }
    throw err;
  }

  if (subject.developerAppId !== resolved.developerAppId) {
    throw new ApiKeySignerSessionError(
      "invalid_grant",
      "API key does not belong to this developer app",
      400,
    );
  }

  const minted = await mintSignerJwtForExternalUser({
    publicClientId: resolved.publicClientId,
    developerAppId: resolved.developerAppId,
    externalUserId: subject.externalUserId,
  });

  return buildSignerSessionEnvelope({
    access_token: minted.access_token,
    expires_in: minted.expires_in,
    scope: minted.scope,
    balanceUsdMicros: minted.balanceUsdMicros,
    lifetimeGrantedUsdMicros: minted.lifetimeGrantedUsdMicros,
    signer_url: resolvePublicSignerUrl(),
    issued_token_type: ISSUED_ACCESS_TOKEN_TYPE,
  });
}
