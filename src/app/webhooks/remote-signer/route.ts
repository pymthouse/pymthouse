import { buildRemoteSignerWebhookConfig } from "@/lib/signer/remote-signer-webhook-config";
import { handleAuthorize } from "@pymthouse/clearinghouse-identity-webhook/protocol";

function buildWebhookConfig() {
  return buildRemoteSignerWebhookConfig();
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
