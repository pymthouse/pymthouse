import type { RemoteSignerWebhookConfig } from "@pymthouse/clearinghouse-identity-webhook/protocol";
import { createEndUserVerifierFromEnv } from "@pymthouse/clearinghouse-identity-webhook/verifiers";
import { buildSignerBalanceCheck } from "@/lib/oidc/signer-balance-gate";

/**
 * Build the remote-signer webhook config from the package's canonical
 * IDENTITY_* / OIDC_* env (see createEndUserVerifierFromEnv). No claim or
 * issuer translation — set those vars in the deployment environment.
 */
export function buildRemoteSignerWebhookConfig(
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
): RemoteSignerWebhookConfig {
  const source = env ?? process.env;
  const config: RemoteSignerWebhookConfig = {
    webhookSecret: source.WEBHOOK_SECRET?.trim() || "",
    endUserAuth: createEndUserVerifierFromEnv(source),
  };

  const checkBalance = buildSignerBalanceCheck();
  if (checkBalance) {
    config.checkBalance = checkBalance;
  }
  return config;
}
