import {
  WebhookError,
  type EndUserAuthVerifier,
} from "@pymthouse/clearinghouse-identity-webhook/protocol";

/**
 * Try verifiers in order; return the first successful result. Re-throws the last
 * {@link WebhookError} or wraps other errors so the JWT/OIDC path stays unchanged.
 */
export function createFirstMatchEndUserVerifier(
  verifiers: EndUserAuthVerifier[],
): EndUserAuthVerifier {
  if (verifiers.length === 0) {
    throw new WebhookError("at least one verifier is required", {
      status: 500,
      code: "invalid_verifier_config",
    });
  }

  return {
    kind: "composite",
    verify: async (context) => {
      let lastError: unknown;
      for (const verifier of verifiers) {
        try {
          return await verifier.verify(context);
        } catch (err) {
          lastError = err;
        }
      }
      if (lastError instanceof WebhookError) {
        throw lastError;
      }
      if (lastError instanceof Error) {
        throw new WebhookError(lastError.message, {
          status: 401,
          code: "invalid_credentials",
        });
      }
      throw new WebhookError("authorization rejected", { status: 403 });
    },
  };
}
