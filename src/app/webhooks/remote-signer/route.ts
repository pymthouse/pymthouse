import { getIssuer } from "@/lib/oidc/issuer-urls";
import { createOpaqueSessionEndUserVerifier } from "@/lib/signer/opaque-session-verifier";
import {
  createFirstMatchEndUserVerifier,
  createSignerDmzRemoteSignerWebhookConfig,
  handleRemoteSignerAuthorize,
  type RemoteSignerWebhookConfig,
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

function buildWebhookConfig(): RemoteSignerWebhookConfig {
  const jwtIssuer = process.env.JWT_ISSUER?.trim() || getIssuer();
  const jwtAudience = process.env.JWT_AUDIENCE?.trim() || jwtIssuer;
  const webhookSecret = process.env.WEBHOOK_SECRET?.trim() || "";

  // Unchanged JWT + Apache trusted-headers verification (the intended,
  // long-term per-user signer-JWT attribution contract).
  const base = createSignerDmzRemoteSignerWebhookConfig({
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

  // Additive: also accept the opaque `pmth_*` remote-signer session so a billed
  // `/generate-live-payment` is symmetric with the already-working
  // `/sign-orchestrator-info`. The opaque verifier only matches `pmth_` bearers
  // and validates them against PymtHouse; every other bearer falls through to
  // the unchanged JWT path above.
  const opaqueSessionVerifier = createOpaqueSessionEndUserVerifier({
    issuer: jwtIssuer,
  });

  return {
    webhookSecret: base.webhookSecret,
    endUserAuth: createFirstMatchEndUserVerifier([
      opaqueSessionVerifier,
      base.endUserAuth,
    ]),
    afterVerify: base.afterVerify,
  };
}

export async function POST(request: Request): Promise<Response> {
  const webhookSecret = process.env.WEBHOOK_SECRET?.trim() || "";
  if (!webhookSecret) {
    return Response.json(
      { status: 500, reason: "server misconfiguration" },
      { status: 500 },
    );
  }

  return handleRemoteSignerAuthorize(request, buildWebhookConfig());
}
