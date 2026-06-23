import { buildRemoteSignerWebhookConfig } from "@/lib/signer/end-user-identity-config";
import { handleRemoteSignerAuthorize } from "@pymthouse/builder-sdk/signer/webhook";

export async function POST(request: Request): Promise<Response> {
  const webhookSecret = process.env.WEBHOOK_SECRET?.trim() || "";
  if (!webhookSecret) {
    return Response.json(
      { status: 500, reason: "server misconfiguration" },
      { status: 500 },
    );
  }

  return handleRemoteSignerAuthorize(request, buildRemoteSignerWebhookConfig());
}
