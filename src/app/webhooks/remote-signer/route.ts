import { getIssuer } from "@/lib/oidc/issuer-urls";
import { resolveActiveAppApiKeyByToken } from "@/lib/app-api-keys";
import {
  createApiKeyEndUserVerifier,
  createFirstMatchEndUserVerifier,
  createOidcEndUserVerifier,
  createTrustedHeadersEndUserVerifier,
  handleRemoteSignerAuthorize,
  type EndUserAuthVerifier,
  type RemoteSignerWebhookConfig,
} from "@pymthouse/builder-sdk/signer/webhook";

function boolEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function isHttpIssuer(issuer: string): boolean {
  try {
    const parsed = new URL(issuer);
    return parsed.protocol === "http:";
  } catch {
    return issuer.startsWith("http://");
  }
}

type SignerAuthMode = "oidc" | "api_key" | "both";

function resolveSignerAuthMode(): SignerAuthMode {
  const raw = process.env.SIGNER_AUTH_MODE?.trim().toLowerCase();
  if (raw === "oidc" || raw === "api_key") {
    return raw;
  }
  return "both";
}

/**
 * Build the webhook config with explicit, independently toggleable bearer paths.
 *
 * - OIDC JWT path: a signed JWT verified against the issuer JWKS (iss/aud/`sign:job`),
 *   honoring the per-app TTL baked into the minted JWT `exp`.
 * - pmth API-key path: an opaque `pmth_*` credential resolved against the DB; no JWT.
 *
 * `SIGNER_AUTH_MODE` (`oidc` | `api_key` | `both`, default `both`) selects which
 * paths are active. When the Apache DMZ injects identity headers, those are tried
 * first (trusted-headers verifier) before the bearer paths.
 */
function buildWebhookConfig(): RemoteSignerWebhookConfig {
  const jwtIssuer = process.env.JWT_ISSUER?.trim() || getIssuer();
  const jwtAudience = process.env.JWT_AUDIENCE?.trim() || jwtIssuer;
  const webhookSecret = process.env.WEBHOOK_SECRET?.trim() || "";
  const allowInsecureHttp =
    boolEnv(process.env.ALLOW_INSECURE_HTTP) || isHttpIssuer(jwtIssuer);
  const mode = resolveSignerAuthMode();

  const oidcVerifier = createOidcEndUserVerifier({
    webhookSecret,
    jwtIssuer,
    jwtAudience,
    claimMapping: {
      claimClientId: process.env.CLAIM_CLIENT_ID?.trim() || "client_id",
      claimUsageSubject:
        process.env.CLAIM_USAGE_SUBJECT?.trim() || "external_user_id",
      usageSubjectType:
        process.env.USAGE_SUBJECT_TYPE?.trim() || "external_user_id",
    },
    requiredScopes: ["sign:job"],
    allowInsecureHttp,
  });

  const apiKeyVerifier = createApiKeyEndUserVerifier({
    issuer: jwtIssuer,
    apiKeyPrefix: "pmth_",
    defaultUsageSubjectType: "external_user_id",
    resolveApiKey: async (apiKey) => {
      const resolved = await resolveActiveAppApiKeyByToken(apiKey);
      if (!resolved) {
        return null;
      }
      return {
        userId: resolved.externalUserId,
        clientId: resolved.publicClientId,
        usageSubjectType: "external_user_id",
      };
    },
  });

  const bearerVerifiers: EndUserAuthVerifier[] = [];
  if (mode === "oidc" || mode === "both") {
    bearerVerifiers.push(oidcVerifier);
  }
  if (mode === "api_key" || mode === "both") {
    bearerVerifiers.push(apiKeyVerifier);
  }

  const dmzTrustedHeaders = process.env.SIGNER_DMZ_TRUSTED_HEADERS;
  const verifiers: EndUserAuthVerifier[] =
    boolEnv(dmzTrustedHeaders ?? "1")
      ? [
          createTrustedHeadersEndUserVerifier({ expectedIssuer: jwtIssuer }),
          ...bearerVerifiers,
        ]
      : bearerVerifiers;

  const endUserAuth =
    verifiers.length === 1
      ? verifiers[0]
      : createFirstMatchEndUserVerifier(verifiers);

  return { webhookSecret, endUserAuth };
}

export async function POST(request: Request): Promise<Response> {
  const webhookSecret = process.env.WEBHOOK_SECRET?.trim() || "";
  if (!webhookSecret) {
    return Response.json(
      { status: 500, reason: "server misconfiguration" },
      { status: 500 },
    );
  }

  return handleRemoteSignerAuthorize(request, buildWebhookConfig());
}
