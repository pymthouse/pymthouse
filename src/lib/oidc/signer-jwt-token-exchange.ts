import { eq } from "drizzle-orm";
import { db } from "@/db/index";
import { oidcClients } from "@/db/schema";
import { hasScope } from "@/lib/auth";
import { validateClientSecret } from "@/lib/oidc/clients";
import {
  DeveloperAppSiblingAmbiguousError,
  resolveDeveloperAppAndPublicClientForOidcRow,
  type DrizzleDb,
} from "@/lib/oidc/client-sibling";
import {
  SIGN_MINT_USER_TOKEN_SCOPE,
  mintSignerJwtForExternalUser,
  signerJwtAudience,
} from "@/lib/oidc/mint-user-signer-token";
import {
  resolveSubjectAccessToken,
  subjectAccessTokenResolveErrorToTokenExchange,
  SubjectAccessTokenResolveError,
} from "@/lib/oidc/resolve-subject-access-token";
import { scopeStringFromPayload } from "@/lib/oidc/scope-string";
import { TokenExchangeError } from "@/lib/oidc/token-exchange";

export const SUBJECT_ACCESS_TOKEN_TYPE =
  "urn:ietf:params:oauth:token-type:access_token";

/**
 * RFC 8693 §2.2.1 requires `issued_token_type` on every token-exchange
 * response. The signer JWT is an access token (consistent with the device and
 * gateway exchanges), so callers never have to derive this value client-side.
 */
const ISSUED_ACCESS_TOKEN_TYPE =
  "urn:ietf:params:oauth:token-type:access_token";

const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const DEVICE_CODE_RESOURCE_PREFIX = "urn:pmth:device_code:";

export type SignerJwtTokenExchangeDeps = {
  validateClientSecret: typeof validateClientSecret;
  db: DrizzleDb;
  resolveDeveloperAppAndPublicClientForOidcRow: typeof resolveDeveloperAppAndPublicClientForOidcRow;
  resolveSubjectAccessToken: typeof resolveSubjectAccessToken;
  mintSignerJwtForExternalUser: typeof mintSignerJwtForExternalUser;
};

const defaultSignerJwtExchangeDeps: SignerJwtTokenExchangeDeps = {
  validateClientSecret,
  db,
  resolveDeveloperAppAndPublicClientForOidcRow,
  resolveSubjectAccessToken,
  mintSignerJwtForExternalUser,
};

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") {
    end -= 1;
  }
  return value.slice(0, end);
}

function normalizeResourceOrAudience(value: string): string {
  return trimTrailingSlashes(value.trim());
}

function targetsSignerJwtAudience(input: {
  resource: string | null | undefined;
  audience?: string[];
}): boolean {
  const expected = signerJwtAudience();
  const resource = input.resource?.trim() ?? "";
  if (resource && normalizeResourceOrAudience(resource) === expected) {
    return true;
  }
  for (const raw of input.audience ?? []) {
    if (normalizeResourceOrAudience(raw) === expected) {
      return true;
    }
  }
  return false;
}

export function isSignerJwtTokenExchangeRequest(params: {
  grantType: string;
  subjectTokenType: string;
  resource: string | null | undefined;
  audience?: string[];
}): boolean {
  const resource = params.resource?.trim() ?? "";
  if (resource.startsWith(DEVICE_CODE_RESOURCE_PREFIX)) {
    return false;
  }
  return (
    params.grantType === TOKEN_EXCHANGE_GRANT &&
    params.subjectTokenType.trim() === SUBJECT_ACCESS_TOKEN_TYPE &&
    targetsSignerJwtAudience(params)
  );
}

export async function handleSignerJwtTokenExchange(
  params: {
    clientId: string;
    clientSecret: string;
    subjectToken: string;
    subjectTokenType: string;
    resource?: string | null;
    audience?: string[];
  },
  inject: Partial<SignerJwtTokenExchangeDeps> = {},
): Promise<{
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
  issued_token_type: string;
  balanceUsdMicros: string;
  lifetimeGrantedUsdMicros: string;
}> {
  const deps: SignerJwtTokenExchangeDeps = {
    ...defaultSignerJwtExchangeDeps,
    ...inject,
  };
  const dbConn = deps.db;

  if (params.subjectTokenType.trim() !== SUBJECT_ACCESS_TOKEN_TYPE) {
    throw new TokenExchangeError(
      "unsupported_token_type",
      `For signer JWT exchange, subject_token_type must be ${SUBJECT_ACCESS_TOKEN_TYPE}`,
    );
  }

  if (
    !isSignerJwtTokenExchangeRequest({
      grantType: TOKEN_EXCHANGE_GRANT,
      subjectTokenType: params.subjectTokenType,
      resource: params.resource,
      audience: params.audience,
    })
  ) {
    throw new TokenExchangeError(
      "invalid_target",
      `resource or audience must be ${signerJwtAudience()}`,
    );
  }

  if (!(await deps.validateClientSecret(params.clientId, params.clientSecret))) {
    throw new TokenExchangeError("invalid_client", "Invalid client credentials");
  }

  const clientRows = await dbConn
    .select()
    .from(oidcClients)
    .where(eq(oidcClients.clientId, params.clientId))
    .limit(1);
  const callerRow = clientRows[0];
  if (!callerRow?.clientSecretHash) {
    throw new TokenExchangeError(
      "invalid_client",
      "Client not found or not confidential",
    );
  }

  if (
    !hasScope(callerRow.allowedScopes, SIGN_MINT_USER_TOKEN_SCOPE) &&
    !hasScope(callerRow.allowedScopes, "users:token")
  ) {
    throw new TokenExchangeError(
      "invalid_scope",
      `Requires ${SIGN_MINT_USER_TOKEN_SCOPE} or users:token on the confidential client`,
    );
  }

  let sibling: { developerAppId: string; publicClientId: string } | null;
  try {
    sibling = await deps.resolveDeveloperAppAndPublicClientForOidcRow(
      dbConn,
      callerRow.id,
    );
  } catch (err) {
    if (err instanceof DeveloperAppSiblingAmbiguousError) {
      throw new TokenExchangeError(
        "invalid_request",
        err.message,
        "Ambiguous developer app mapping for this client",
      );
    }
    throw err;
  }
  if (!sibling) {
    throw new TokenExchangeError(
      "invalid_client",
      "No developer app linked to this client",
    );
  }

  let resolved;
  try {
    resolved = await deps.resolveSubjectAccessToken(params.subjectToken, {
      expectedPublicClientId: sibling.publicClientId,
      dbConn,
    });
  } catch (err) {
    if (err instanceof SubjectAccessTokenResolveError) {
      throw subjectAccessTokenResolveErrorToTokenExchange(err);
    }
    throw err;
  }

  if (resolved.developerAppId !== sibling.developerAppId) {
    throw new TokenExchangeError(
      "invalid_grant",
      "subject_token does not belong to this developer app",
    );
  }

  const scopeStr = scopeStringFromPayload(resolved.payload);
  if (!hasScope(scopeStr, "sign:job")) {
    throw new TokenExchangeError(
      "invalid_grant",
      "subject_token must include sign:job scope",
    );
  }

  const minted = await deps.mintSignerJwtForExternalUser({
    publicClientId: sibling.publicClientId,
    developerAppId: sibling.developerAppId,
    externalUserId: resolved.externalUserId,
  });

  return {
    access_token: minted.access_token,
    token_type: "Bearer",
    expires_in: minted.expires_in,
    scope: minted.scope,
    issued_token_type: ISSUED_ACCESS_TOKEN_TYPE,
    balanceUsdMicros: minted.balanceUsdMicros,
    lifetimeGrantedUsdMicros: minted.lifetimeGrantedUsdMicros,
  };
}
