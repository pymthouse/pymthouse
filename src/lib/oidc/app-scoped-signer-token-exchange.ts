import { hasScope } from "@/lib/auth";
import {
  resolveActiveAppApiKey,
} from "@/lib/app-api-keys";
import { validateClientSecret } from "@/lib/oidc/clients";
import {
  mintSignerJwtForExternalUser,
  MintUserSignerTokenError,
  signerJwtAudience,
} from "@/lib/oidc/mint-user-signer-token";
import {
  resolveSubjectAccessToken,
  SubjectAccessTokenResolveError,
} from "@/lib/oidc/resolve-subject-access-token";
import { scopeStringFromPayload } from "@/lib/oidc/scope-string";
import { buildSignerSessionEnvelope } from "@/lib/openapi/signer-session";
import { getClientSignerApiUrl } from "@/lib/signer-proxy";
import type { SignerSession } from "@/lib/openapi/schemas/credentials-types";

export const GRANT_TYPE_TOKEN_EXCHANGE =
  "urn:ietf:params:oauth:grant-type:token-exchange";

export const SUBJECT_ACCESS_TOKEN_TYPE =
  "urn:ietf:params:oauth:token-type:access_token";

// Same URN as SUBJECT — intentionally separate constants for RFC 8693 semantics:
// SUBJECT identifies the inbound token type; ISSUED identifies the outbound token type.
const ISSUED_ACCESS_TOKEN_TYPE =
  "urn:ietf:params:oauth:token-type:access_token";

const LEGACY_SIGNER_AUDIENCES = new Set([
  "livepeer-clearinghouse",
  "livepeer-remote-signer",
]);

/** Composite API keys are `app_<24hex>_<secret>` (lowercase hex; no dots). */
const COMPOSITE_APP_API_KEY_PREFIX_RE = /^app_[a-f0-9]{24}_/;
/** Full composite key with a non-empty secret segment. */
const COMPOSITE_APP_API_KEY_RE = /^app_[a-f0-9]{24}_.+/;
/** Opaque hex secret from a composite exchange (subject_token after split). */
const OPAQUE_HEX_SECRET_RE = /^[a-f0-9]{32,}$/i;

export class AppScopedSignerTokenExchangeError extends Error {
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

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") {
    end -= 1;
  }
  return value.slice(0, end);
}

function normalizeUri(value: string): string {
  return trimTrailingSlashes(value.trim());
}

export function getSignerTokenAudienceEnv(): string | null {
  const raw = process.env.SIGNER_TOKEN_AUDIENCE?.trim();
  return raw ? normalizeUri(raw) : null;
}

export function getSignerDiscoveryUrl(): string | undefined {
  const raw = process.env.DISCOVERY_URL?.trim();
  return raw || undefined;
}

export function acceptedSignerAudiences(): Set<string> {
  const audiences = new Set<string>();
  audiences.add(signerJwtAudience());
  const configured = getSignerTokenAudienceEnv();
  if (configured) {
    audiences.add(configured);
  }
  for (const legacy of LEGACY_SIGNER_AUDIENCES) {
    audiences.add(legacy);
  }
  return audiences;
}

function isJwtSubjectToken(subjectToken: string): boolean {
  if (subjectToken.startsWith("pmth_")) {
    return false;
  }
  // Composite API keys are `app_<24hex>_<secret>` (no dots); JWTs have three segments.
  if (COMPOSITE_APP_API_KEY_PREFIX_RE.test(subjectToken)) {
    return false;
  }
  // Opaque hex secret from a composite exchange (subject_token after split).
  if (OPAQUE_HEX_SECRET_RE.test(subjectToken)) {
    return false;
  }
  return subjectToken.split(".").length === 3;
}

export function validateRequestedTokenType(requested: string): void {
  const trimmed = requested.trim();
  if (!trimmed || trimmed === ISSUED_ACCESS_TOKEN_TYPE) {
    return;
  }
  throw new AppScopedSignerTokenExchangeError(
    "invalid_request",
    `requested_token_type must be ${ISSUED_ACCESS_TOKEN_TYPE} or omitted`,
  );
}

export function validateSignerTarget(
  resource: string,
  audiences: string[],
): void {
  const accepted = acceptedSignerAudiences();
  const resourceTrimmed = resource.trim();
  if (resourceTrimmed) {
    if (!accepted.has(normalizeUri(resourceTrimmed))) {
      throw new AppScopedSignerTokenExchangeError(
        "invalid_target",
        "resource must be omitted or name the signer audience",
      );
    }
    return;
  }

  const nonEmpty = audiences.map((aud) => aud.trim()).filter(Boolean);
  if (nonEmpty.length === 0) {
    return;
  }

  for (const aud of nonEmpty) {
    if (!accepted.has(normalizeUri(aud))) {
      throw new AppScopedSignerTokenExchangeError(
        "invalid_target",
        "audience must be omitted or name the signer audience",
      );
    }
  }
}

export async function validateOptionalM2mClient(
  clientId: string,
  clientSecret: string,
  validateSecret: typeof validateClientSecret = validateClientSecret,
): Promise<void> {
  const id = clientId.trim();
  const secret = clientSecret.trim();
  if (!id && !secret) {
    return;
  }
  if (!id || !secret) {
    throw new AppScopedSignerTokenExchangeError(
      "invalid_client",
      "client authentication requires both client id and secret",
      401,
    );
  }
  if (!(await validateSecret(id, secret))) {
    throw new AppScopedSignerTokenExchangeError(
      "invalid_client",
      "invalid client credentials",
      401,
    );
  }
}

type ResolvedSubject = {
  publicClientId: string;
  developerAppId: string;
  externalUserId: string;
  payload?: Record<string, unknown>;
};

export async function resolveAppScopedSubjectToken(
  subjectToken: string,
  publicClientId: string,
  inject: Partial<AppScopedSignerTokenExchangeDeps> = {},
): Promise<ResolvedSubject> {
  const deps = { ...defaultAppScopedExchangeDeps, ...inject };
  const token = subjectToken.trim();
  if (!token) {
    throw new AppScopedSignerTokenExchangeError(
      "invalid_request",
      "subject_token is required",
    );
  }

  if (isJwtSubjectToken(token)) {
    try {
      const resolved = await deps.resolveSubjectAccessToken(token, {
        expectedPublicClientId: publicClientId,
      });
      return {
        publicClientId: resolved.publicClientId,
        developerAppId: resolved.developerAppId,
        externalUserId: resolved.externalUserId,
        payload: resolved.payload,
      };
    } catch (err) {
      if (err instanceof SubjectAccessTokenResolveError) {
        throw new AppScopedSignerTokenExchangeError(
          err.code,
          err.message,
          err.status,
        );
      }
      throw err;
    }
  }

  // Bare stored API key, composite app_*_*, or opaque hex secret segment.
  const looksLikeApiKey =
    (token.startsWith("pmth_") && !token.startsWith("pmth_cs_")) ||
    COMPOSITE_APP_API_KEY_RE.test(token) ||
    OPAQUE_HEX_SECRET_RE.test(token);
  if (!looksLikeApiKey) {
    throw new AppScopedSignerTokenExchangeError(
      "invalid_grant",
      "subject_token is not a valid access token for this issuer",
    );
  }

  const resolved = await deps.resolveActiveAppApiKey(token, publicClientId);
  if (!resolved) {
    throw new AppScopedSignerTokenExchangeError(
      "invalid_grant",
      "subject_token is not a valid access token for this issuer",
    );
  }

  return {
    publicClientId: resolved.publicClientId,
    developerAppId: resolved.developerAppId,
    externalUserId: resolved.externalUserId,
  };
}

export type AppScopedSignerTokenExchangeDeps = {
  validateClientSecret: typeof validateClientSecret;
  resolveActiveAppApiKey: typeof resolveActiveAppApiKey;
  resolveSubjectAccessToken: typeof resolveSubjectAccessToken;
  mintSignerJwtForExternalUser: typeof mintSignerJwtForExternalUser;
  getClientSignerApiUrl: typeof getClientSignerApiUrl;
  getSignerDiscoveryUrl: typeof getSignerDiscoveryUrl;
};

const defaultAppScopedExchangeDeps: AppScopedSignerTokenExchangeDeps = {
  validateClientSecret,
  resolveActiveAppApiKey,
  resolveSubjectAccessToken,
  mintSignerJwtForExternalUser,
  getClientSignerApiUrl,
  getSignerDiscoveryUrl,
};

export async function handleAppScopedSignerTokenExchange(
  input: {
    publicClientId: string;
    clientId: string;
    clientSecret: string;
    grantType: string;
    subjectToken: string;
    subjectTokenType: string;
    requestedTokenType: string;
    resource: string;
    audiences: string[];
    correlationId: string;
  },
  inject: Partial<AppScopedSignerTokenExchangeDeps> = {},
): Promise<SignerSession> {
  const deps = { ...defaultAppScopedExchangeDeps, ...inject };
  const publicClientId = input.publicClientId.trim();
  if (!publicClientId) {
    throw new AppScopedSignerTokenExchangeError(
      "invalid_request",
      "clientId is required",
    );
  }

  if (input.grantType.trim() !== GRANT_TYPE_TOKEN_EXCHANGE) {
    throw new AppScopedSignerTokenExchangeError(
      "invalid_request",
      `grant_type must be ${GRANT_TYPE_TOKEN_EXCHANGE}`,
    );
  }

  if (!input.subjectToken.trim()) {
    throw new AppScopedSignerTokenExchangeError(
      "invalid_request",
      "subject_token is required",
    );
  }

  if (input.subjectTokenType.trim() !== SUBJECT_ACCESS_TOKEN_TYPE) {
    throw new AppScopedSignerTokenExchangeError(
      "unsupported_token_type",
      `subject_token_type must be ${SUBJECT_ACCESS_TOKEN_TYPE}`,
    );
  }

  await validateOptionalM2mClient(input.clientId, input.clientSecret, deps.validateClientSecret);
  validateRequestedTokenType(input.requestedTokenType);
  validateSignerTarget(input.resource, input.audiences);

  const subject = await resolveAppScopedSubjectToken(
    input.subjectToken,
    publicClientId,
    inject,
  );

  if (subject.publicClientId !== publicClientId) {
    throw new AppScopedSignerTokenExchangeError(
      "invalid_grant",
      "subject_token client does not match this app",
    );
  }

  if (subject.payload) {
    const scopeStr = scopeStringFromPayload(subject.payload);
    if (!hasScope(scopeStr, "sign:job")) {
      throw new AppScopedSignerTokenExchangeError(
        "invalid_grant",
        "subject_token must include sign:job scope",
      );
    }
  }

  let minted;
  try {
    minted = await deps.mintSignerJwtForExternalUser({
      publicClientId: subject.publicClientId,
      developerAppId: subject.developerAppId,
      externalUserId: subject.externalUserId,
    });
  } catch (err) {
    if (err instanceof MintUserSignerTokenError) {
      throw new AppScopedSignerTokenExchangeError(
        err.code,
        err.message,
        err.status,
      );
    }
    throw err;
  }

  return buildSignerSessionEnvelope({
    access_token: minted.access_token,
    expires_in: minted.expires_in,
    scope: minted.scope,
    balanceUsdMicros: minted.balanceUsdMicros,
    lifetimeGrantedUsdMicros: minted.lifetimeGrantedUsdMicros,
    signer_url: deps.getClientSignerApiUrl(subject.publicClientId),
    discovery_url: deps.getSignerDiscoveryUrl(),
    issued_token_type: ISSUED_ACCESS_TOKEN_TYPE,
    correlation_id: input.correlationId,
  });
}
