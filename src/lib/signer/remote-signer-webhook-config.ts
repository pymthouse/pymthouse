import { getIssuer } from "@/lib/oidc/issuer-urls";
import { createCompositeAppApiKeyVerifier } from "@/lib/signer/composite-app-api-key-verifier";
import { createFirstMatchEndUserVerifier } from "@/lib/signer/first-match-verifier";
import { createOpaqueSessionEndUserVerifier } from "@/lib/signer/opaque-session-verifier";
import {
  createLegacyOidcVerifierFromEnv,
  createLegacyWebhookConfigFromEnv,
} from "@pymthouse/clearinghouse-identity-webhook/legacy-env";
import type { RemoteSignerWebhookConfig } from "@pymthouse/clearinghouse-identity-webhook/protocol";

export type RemoteSignerWebhookConfigOptions = {
  env?: NodeJS.ProcessEnv;
  resolveActiveAppApiKey?: Parameters<
    typeof createCompositeAppApiKeyVerifier
  >[0]["resolveActiveAppApiKey"];
};

export function buildRemoteSignerWebhookConfig(
  options: RemoteSignerWebhookConfigOptions = {},
): RemoteSignerWebhookConfig {
  const env = options.env ?? process.env;
  const jwtIssuer = env.JWT_ISSUER?.trim() || getIssuer();
  const base = createLegacyWebhookConfigFromEnv(env, { jwtIssuer });

  const opaqueSessionVerifier = createOpaqueSessionEndUserVerifier({
    issuer: jwtIssuer,
  });
  const compositeAppApiKeyVerifier = createCompositeAppApiKeyVerifier({
    issuer: jwtIssuer,
    resolveActiveAppApiKey: options.resolveActiveAppApiKey,
  });

  return {
    webhookSecret: base.webhookSecret,
    endUserAuth: createFirstMatchEndUserVerifier([
      opaqueSessionVerifier,
      compositeAppApiKeyVerifier,
      createLegacyOidcVerifierFromEnv(env, { jwtIssuer }),
    ]),
  };
}
