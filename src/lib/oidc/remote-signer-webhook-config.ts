import type { RemoteSignerWebhookConfig } from "@pymthouse/clearinghouse-identity-webhook/protocol";
import {
  createEndUserVerifierFromEnv,
  createOidcVerifier,
} from "@pymthouse/clearinghouse-identity-webhook/verifiers";
import {
  OIDC_MOUNT_PATH,
  ensureHttpsForProduction,
  getIssuer,
  getPublicOrigin,
} from "@/lib/oidc/issuer-urls";
import { createLocalSignerJwksResolver } from "@/lib/oidc/local-signer-jwks";
import { buildSignerBalanceCheck } from "@/lib/oidc/signer-balance-gate";
import { timeSignerWebhookPhase } from "@/lib/oidc/signer-webhook-metrics";
import { buildOwnerCustomerKey } from "@/lib/openmeter/customer-key";
import { trimTrailingSlashes } from "@/lib/openapi/string-utils";

type EnvSource = NodeJS.ProcessEnv | Record<string, string | undefined>;

type EndUserVerifier = RemoteSignerWebhookConfig["endUserAuth"];

/**
 * Map owner JWTs (bare platform user id + user_type=app_owner) onto webhook
 * usage_subject owner:{id} so go-livepeer auth_id / CloudEvent settlement use
 * the shared Konnect customer key. JWT claims stay bare for clients.
 */
function withOwnerBillingUsageSubject(verifier: EndUserVerifier): EndUserVerifier {
  return {
    ...verifier,
    verify: async (input) => {
      const result = await verifier.verify(input);
      const raw = result.raw as Record<string, unknown> | undefined;
      const userType =
        typeof raw?.user_type === "string" ? raw.user_type.trim() : "";
      if (userType !== "app_owner") {
        return result;
      }
      const bareId = result.identity.usage_subject.trim();
      if (!bareId || bareId.startsWith("owner:")) {
        return {
          ...result,
          identity: {
            ...result.identity,
            usage_subject_type: "app_owner",
          },
        };
      }
      return {
        ...result,
        identity: {
          ...result.identity,
          usage_subject: buildOwnerCustomerKey(bareId),
          usage_subject_type: "app_owner",
        },
      };
    },
  };
}

function trimEnv(env: EnvSource, name: string): string {
  const value = env[name];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Resolve the OIDC issuer URL from a partial env map (tests) or process.env.
 * Prefer IDENTITY_ISSUER; OIDC_ISSUER remains a legacy alias.
 */
function resolveIssuer(env: EnvSource): string {
  const configured =
    trimEnv(env, "IDENTITY_ISSUER") ||
    trimEnv(env, "OIDC_ISSUER") ||
    trimEnv(env, "NEXTAUTH_URL");
  if (!configured) {
    return getIssuer();
  }
  const normalized = trimTrailingSlashes(ensureHttpsForProduction(configured));
  return normalized.endsWith(OIDC_MOUNT_PATH)
    ? normalized
    : `${normalized}${OIDC_MOUNT_PATH}`;
}

/**
 * Fill PymtHouse defaults for the identity-webhook verifier so deployments only
 * need NEXTAUTH_URL (plus WEBHOOK_SECRET). Explicit env values always win.
 */
export function resolveIdentityWebhookEnv(env: EnvSource): Record<string, string | undefined> {
  const next: Record<string, string | undefined> = { ...env };
  const issuer = resolveIssuer(env);

  next.IDENTITY_AUTH_MODE = trimEnv(env, "IDENTITY_AUTH_MODE") || "oidc";
  // Always use resolveIssuer so IDENTITY_ISSUER / OIDC_ISSUER / NEXTAUTH_URL
  // get the same HTTPS + mount-path normalization as getIssuer().
  next.IDENTITY_ISSUER = issuer;
  // Package still reads OIDC_ISSUER for JWT iss; keep it aligned with IDENTITY_ISSUER
  // unless an explicit OIDC_ISSUER override is set.
  next.OIDC_ISSUER = trimEnv(env, "OIDC_ISSUER") || next.IDENTITY_ISSUER;
  next.OIDC_AUDIENCE = trimEnv(env, "OIDC_AUDIENCE") || next.OIDC_ISSUER;
  next.OIDC_CLIENT_CLAIM = trimEnv(env, "OIDC_CLIENT_CLAIM") || "client_id";
  next.OIDC_SUBJECT_CLAIM = trimEnv(env, "OIDC_SUBJECT_CLAIM") || "external_user_id";
  next.OIDC_SUBJECT_TYPE = trimEnv(env, "OIDC_SUBJECT_TYPE") || "external_user_id";
  next.OIDC_REQUIRED_SCOPES = trimEnv(env, "OIDC_REQUIRED_SCOPES") || "sign:job";

  if (!trimEnv(env, "OIDC_TOKEN_EXCHANGE_BASE_URL")) {
    const fromNextAuth =
      trimEnv(env, "NEXTAUTH_URL") ||
      (env === process.env ? getPublicOrigin() : "");
    if (fromNextAuth) {
      next.OIDC_TOKEN_EXCHANGE_BASE_URL = trimTrailingSlashes(fromNextAuth);
    } else {
      try {
        next.OIDC_TOKEN_EXCHANGE_BASE_URL = new URL(issuer).origin;
      } catch {
        /* leave unset */
      }
    }
  }

  return next;
}

/** App origin serving this webhook, matching the env source used for issuer resolution. */
function resolveAppOrigin(source: EnvSource, original: EnvSource): string {
  const fromEnv = trimEnv(source, "NEXTAUTH_URL");
  if (fromEnv) {
    return trimTrailingSlashes(ensureHttpsForProduction(fromEnv));
  }
  return original === process.env ? getPublicOrigin() : "";
}

/** True when the JWT issuer is served by this deployment (self-issued tokens). */
function isSelfIssuedJwtIssuer(jwtIssuer: string, appOrigin: string): boolean {
  if (!jwtIssuer || !appOrigin) {
    return false;
  }
  try {
    return new URL(jwtIssuer).origin === new URL(appOrigin).origin;
  } catch {
    return false;
  }
}

/** fetch wrapper that logs composite token-exchange latency per request. */
function createTimedExchangeFetch(): typeof fetch {
  return (input, init) =>
    timeSignerWebhookPhase("token_exchange", () => fetch(input, init));
}

function parseRequiredScopes(source: EnvSource): string[] {
  return trimEnv(source, "OIDC_REQUIRED_SCOPES").split(/[\s,]+/).filter(Boolean);
}

/**
 * The identity-webhook package bundles its own jose whose JWK type differs
 * nominally (kty required vs optional) from the app's jose. The resolver is
 * runtime-compatible, so bridge the two declaration trees with a direct cast.
 */
type OidcVerifierJwks = NonNullable<Parameters<typeof createOidcVerifier>[0]["jwks"]>;

/**
 * Build the end-user verifier. For self-issued OIDC tokens (the normal
 * PymtHouse deployment) the verifier is constructed directly with a local
 * DB-backed JWKS resolver, so warm invocations never perform OIDC discovery
 * or JWKS HTTP requests back to this same host. An explicit OIDC_JWKS_URI or
 * an external issuer falls back to the package's env-driven verifier.
 */
function buildEndUserVerifier(
  source: Record<string, string | undefined>,
  original: EnvSource,
): EndUserVerifier {
  const jwtIssuer = trimEnv(source, "OIDC_ISSUER");
  const selfIssued =
    source.IDENTITY_AUTH_MODE === "oidc" &&
    !trimEnv(source, "OIDC_JWKS_URI") &&
    isSelfIssuedJwtIssuer(jwtIssuer, resolveAppOrigin(source, original));

  if (!selfIssued) {
    return createEndUserVerifierFromEnv(source);
  }

  return createOidcVerifier({
    jwtIssuer,
    jwtAudience: trimEnv(source, "OIDC_AUDIENCE") || jwtIssuer,
    jwks: createLocalSignerJwksResolver() as OidcVerifierJwks,
    issuer: trimEnv(source, "IDENTITY_ISSUER") || jwtIssuer,
    clientClaim: trimEnv(source, "OIDC_CLIENT_CLAIM") || undefined,
    subjectClaim: trimEnv(source, "OIDC_SUBJECT_CLAIM") || undefined,
    subjectTypeValue: trimEnv(source, "OIDC_SUBJECT_TYPE") || undefined,
    requiredScopes: parseRequiredScopes(source),
    tokenExchangeBaseUrl: trimEnv(source, "OIDC_TOKEN_EXCHANGE_BASE_URL") || undefined,
    exchangeM2mClientId: trimEnv(source, "OIDC_EXCHANGE_M2M_CLIENT_ID") || undefined,
    exchangeM2mClientSecret:
      trimEnv(source, "OIDC_EXCHANGE_M2M_CLIENT_SECRET") || undefined,
    fetchImpl: createTimedExchangeFetch(),
  });
}

function withPhaseTiming(verifier: EndUserVerifier): EndUserVerifier {
  return {
    ...verifier,
    verify: (input) =>
      timeSignerWebhookPhase("end_user_verify", () => verifier.verify(input)),
  };
}

/**
 * Build the remote-signer webhook config. Issuer / claim / exchange defaults are
 * applied in {@link resolveIdentityWebhookEnv}; only NEXTAUTH_URL is required
 * in normal PymtHouse deployments.
 */
export function buildRemoteSignerWebhookConfig(
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
): RemoteSignerWebhookConfig {
  const original = env ?? process.env;
  const source = resolveIdentityWebhookEnv(original);
  const config: RemoteSignerWebhookConfig = {
    webhookSecret: source.WEBHOOK_SECRET?.trim() || "",
    endUserAuth: withPhaseTiming(
      withOwnerBillingUsageSubject(buildEndUserVerifier(source, original)),
    ),
  };

  const checkBalance = buildSignerBalanceCheck();
  if (checkBalance) {
    config.checkBalance = (ctx) =>
      timeSignerWebhookPhase("balance_check", async () => checkBalance(ctx));
  }
  return config;
}
