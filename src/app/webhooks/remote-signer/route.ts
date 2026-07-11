import { getIssuer } from "@/lib/oidc/issuer-urls";
import { buildSignerBalanceCheck } from "@/lib/oidc/signer-balance-gate";
import { handleAuthorize } from "@pymthouse/clearinghouse-identity-webhook/protocol";
import { createLegacyWebhookConfigFromEnv } from "@pymthouse/clearinghouse-identity-webhook/legacy-env";

function buildWebhookConfig() {
  return createLegacyWebhookConfigFromEnv(process.env, {
    jwtIssuer: process.env.JWT_ISSUER?.trim() || getIssuer(),
    checkBalance: buildSignerBalanceCheck(),
  });
}

export async function POST(request: Request): Promise<Response> {
  const webhookSecret = process.env.WEBHOOK_SECRET?.trim() || "";
  if (!webhookSecret) {
    return Response.json(
      { status: 500, reason: "server misconfiguration" },
      { status: 500 },
    );
  }

  return handleAuthorize(request, buildWebhookConfig());
}
