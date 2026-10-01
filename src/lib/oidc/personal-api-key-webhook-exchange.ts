import { createHash } from "node:crypto";

import {
  bearerToken,
  REMOTE_SIGNER_ERROR_CODE,
  REMOTE_SIGNER_HTTP_STATUS,
  WebhookError,
  type EndUserAuthVerifier,
} from "@pymthouse/clearinghouse-identity-webhook/protocol";
import { createCompositeExchangeCache } from "@pymthouse/clearinghouse-identity-webhook/verifiers";

import { splitCompositeApiKey } from "@/lib/app-api-keys";
import { createCorrelationId } from "@/lib/audit";
import {
  AppScopedSignerTokenExchangeError,
  GRANT_TYPE_TOKEN_EXCHANGE,
  handleIssuerApiKeySignerTokenExchange,
  SUBJECT_API_KEY_TOKEN_TYPE,
} from "@/lib/oidc/app-scoped-signer-token-exchange";

export type PersonalApiKeyExchange = typeof handleIssuerApiKeySignerTokenExchange;

/**
 * True for a stored personal / app-user API key presented without an
 * `app_<24hex>_` prefix. Composite keys stay on the package's path-scoped
 * exchange; client secrets are never subjects.
 */
export function isBarePersonalApiKeyBearer(token: string): boolean {
  const trimmed = token.trim();
  if (!trimmed.startsWith("pmth_") || trimmed.startsWith("pmth_cs_")) {
    return false;
  }
  return splitCompositeApiKey(trimmed) == null;
}

function cacheKeyForToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function webhookErrorFromPersonalApiKeyExchange(
  err: AppScopedSignerTokenExchangeError,
): WebhookError {
  if (
    err.status === REMOTE_SIGNER_HTTP_STATUS.BILLING_UNAVAILABLE ||
    err.code === REMOTE_SIGNER_ERROR_CODE.BILLING_UNAVAILABLE
  ) {
    return new WebhookError(err.message || "billing balance unavailable", {
      status: REMOTE_SIGNER_HTTP_STATUS.BILLING_UNAVAILABLE,
      code: REMOTE_SIGNER_ERROR_CODE.BILLING_UNAVAILABLE,
    });
  }

  if (
    err.status === 402 ||
    err.code === "trial_credits_exhausted" ||
    err.code === REMOTE_SIGNER_ERROR_CODE.INSUFFICIENT_BALANCE
  ) {
    return new WebhookError(err.message || "insufficient balance", {
      status: REMOTE_SIGNER_HTTP_STATUS.INSUFFICIENT_BALANCE,
      code: REMOTE_SIGNER_ERROR_CODE.INSUFFICIENT_BALANCE,
    });
  }

  return new WebhookError(err.message || "token exchange failed", {
    status: 401,
    code: "invalid_token",
  });
}

/**
 * Exchange a bare `pmth_*` personal API key through the issuer-path RFC 8693
 * handler (app resolved from the stored key), then verify the minted JWT with
 * the inner OIDC verifier.
 *
 * `@pymthouse/clearinghouse-identity-webhook` only token-exchanges composite
 * `app_<24hex>_<secret>` Bearers; a bare personal key otherwise fails as
 * "not a JWT".
 */
export function withPersonalApiKeyExchange(
  verifier: EndUserAuthVerifier,
  inject: {
    exchange?: PersonalApiKeyExchange;
  } = {},
): EndUserAuthVerifier {
  const exchange = inject.exchange ?? handleIssuerApiKeySignerTokenExchange;
  const exchangeCache = createCompositeExchangeCache();

  return {
    ...verifier,
    verify: async (input) => {
      const token = bearerToken(input.authorization);
      if (!isBarePersonalApiKeyBearer(token)) {
        return verifier.verify(input);
      }

      const cacheKey = cacheKeyForToken(token);
      const cached = exchangeCache.get(cacheKey);
      if (cached != null) {
        return cached as ReturnType<EndUserAuthVerifier["verify"]>;
      }

      let inflight!: ReturnType<EndUserAuthVerifier["verify"]>;
      inflight = (async () => {
        let accessToken: string;
        try {
          const session = await exchange({
            clientId: "",
            clientSecret: "",
            grantType: GRANT_TYPE_TOKEN_EXCHANGE,
            subjectToken: token,
            subjectTokenType: SUBJECT_API_KEY_TOKEN_TYPE,
            requestedTokenType: "",
            resource: "",
            audiences: [],
            correlationId: createCorrelationId(),
          });
          accessToken = session.access_token.trim();
        } catch (err) {
          if (err instanceof AppScopedSignerTokenExchangeError) {
            throw webhookErrorFromPersonalApiKeyExchange(err);
          }
          throw err;
        }

        if (!accessToken) {
          throw new WebhookError("token exchange returned no access_token", {
            status: 401,
            code: "invalid_token",
          });
        }

        const verified = await verifier.verify({
          ...input,
          authorization: `Bearer ${accessToken}`,
        });
        const ttl = Math.max(1, verified.expiry - Math.floor(Date.now() / 1000));
        exchangeCache.setResultForInflight(cacheKey, inflight, verified, ttl);
        return verified;
      })().catch((err: unknown) => {
        exchangeCache.clearInflight(cacheKey, inflight);
        throw err;
      });

      exchangeCache.setInflight(cacheKey, inflight);
      return inflight;
    },
  };
}
