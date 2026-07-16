import {
  resolveActiveAppApiKey,
  type ResolvedAppApiKey,
} from "@/lib/app-api-keys";
import { parseCompositeAppApiKeyBearer } from "@/lib/signer/composite-app-api-key-bearer";
import {
  bearerToken,
  type EndUserAuthVerifier,
  type UsageIdentity,
} from "@pymthouse/clearinghouse-identity-webhook/protocol";

/**
 * NaaP composite API key bearer for the remote-signer identity webhook.
 *
 * Format: `app_<publicClientId>.pmth_<opaqueSecret>` (PR #210 / NaaP #421).
 * Bare `pmth_*` sessions are handled by {@link createOpaqueSessionEndUserVerifier};
 * JWTs fall through to the OIDC verifier.
 */

const DEFAULT_EXPIRY_TTL_SECONDS = 300;
const USAGE_SUBJECT_TYPE = "external_user_id";

export { parseCompositeAppApiKeyBearer } from "@/lib/signer/composite-app-api-key-bearer";

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") {
    end -= 1;
  }
  return value.slice(0, end);
}

function usageIdentityFromResolvedKey(
  issuer: string,
  resolved: ResolvedAppApiKey,
): UsageIdentity {
  return {
    issuer,
    client_id: resolved.publicClientId,
    usage_subject: resolved.externalUserId,
    usage_subject_type: USAGE_SUBJECT_TYPE,
  };
}

export type CompositeAppApiKeyVerifierConfig = {
  issuer: string;
  expiryTtlSeconds?: number;
  resolveActiveAppApiKey?: typeof resolveActiveAppApiKey;
};

export function createCompositeAppApiKeyVerifier(
  config: CompositeAppApiKeyVerifierConfig,
): EndUserAuthVerifier {
  const issuer = stripTrailingSlashes(config.issuer.trim());
  if (!issuer) {
    throw new Error("issuer is required for composite app API key verification");
  }

  const expiryTtlSeconds =
    config.expiryTtlSeconds && config.expiryTtlSeconds > 0
      ? Math.trunc(config.expiryTtlSeconds)
      : DEFAULT_EXPIRY_TTL_SECONDS;
  const resolveKey = config.resolveActiveAppApiKey ?? resolveActiveAppApiKey;

  return {
    kind: "composite_app_api_key",
    verify: async ({ authorization }) => {
      const token = bearerToken(authorization);
      const parts = parseCompositeAppApiKeyBearer(token);
      if (!parts) {
        throw new Error("not a composite app API key bearer");
      }

      const resolved = await resolveKey(parts.pmthSecret, parts.publicClientId);
      if (!resolved) {
        throw new Error("invalid or unauthorized composite app API key");
      }

      return {
        identity: usageIdentityFromResolvedKey(issuer, resolved),
        expiry: Math.trunc(Date.now() / 1000) + expiryTtlSeconds,
      };
    },
  };
}
