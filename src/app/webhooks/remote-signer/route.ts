import type { RemoteSignerWebhookConfig } from "@pymthouse/clearinghouse-identity-webhook/protocol";
import { handleAuthorize } from "@pymthouse/clearinghouse-identity-webhook/protocol";
import { buildRemoteSignerWebhookConfig } from "@/lib/oidc/remote-signer-webhook-config";
import { timeSignerWebhookPhase } from "@/lib/oidc/signer-webhook-metrics";

/**
 * Built once per process (issue #248): retaining the config keeps the OIDC
 * verifier's JWKS keyset, composite token-exchange cache, and balance-check
 * cache warm across invocations instead of rebuilding them per request.
 */
let cachedConfig: RemoteSignerWebhookConfig | null = null;

function getWebhookConfig(): RemoteSignerWebhookConfig {
  cachedConfig ??= buildRemoteSignerWebhookConfig();
  return cachedConfig;
}

export async function POST(request: Request): Promise<Response> {
  const config = getWebhookConfig();
  if (!config.webhookSecret) {
    return Response.json(
      { status: 500, reason: "server misconfiguration" },
      { status: 500 },
    );
  }

  return timeSignerWebhookPhase("total", () => handleAuthorize(request, config));
}
