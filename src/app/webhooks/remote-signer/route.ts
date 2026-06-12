import { getIssuer } from "@/lib/oidc/issuer-urls";
import {
  createSignerDmzRemoteSignerWebhookConfig,
  handleRemoteSignerAuthorize,
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

function buildWebhookConfig() {
  const jwtIssuer = process.env.JWT_ISSUER?.trim() || getIssuer();
  const jwtAudience = process.env.JWT_AUDIENCE?.trim() || jwtIssuer;
  const webhookSecret = process.env.WEBHOOK_SECRET?.trim() || "";

  return createSignerDmzRemoteSignerWebhookConfig({
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
    allowInsecureHttp:
      boolEnv(process.env.ALLOW_INSECURE_HTTP) || isHttpIssuer(jwtIssuer),
  });
}

export async function POST(request: Request): Promise<Response> {
  const webhookSecret = process.env.WEBHOOK_SECRET?.trim() || "";
  if (!webhookSecret) {
    return Response.json(
      { status: 500, reason: "missing WEBHOOK_SECRET" },
      { status: 500 },
    );
  }

  return handleRemoteSignerAuthorize(request, buildWebhookConfig());
}
