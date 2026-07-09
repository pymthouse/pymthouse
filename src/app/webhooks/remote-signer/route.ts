import { getIssuer } from "@/lib/oidc/issuer-urls";
import { createFirstMatchEndUserVerifier } from "@/lib/signer/first-match-verifier";
import { createOpaqueSessionEndUserVerifier } from "@/lib/signer/opaque-session-verifier";
import { handleAuthorize } from "@pymthouse/clearinghouse-identity-webhook/protocol";
import {
  createLegacyOidcVerifierFromEnv,
  createLegacyWebhookConfigFromEnv,
} from "@pymthouse/clearinghouse-identity-webhook/legacy-env";
import type { RemoteSignerWebhookConfig } from "@pymthouse/clearinghouse-identity-webhook/protocol";

function buildWebhookConfig(): RemoteSignerWebhookConfig {
  const jwtIssuer = process.env.JWT_ISSUER?.trim() || getIssuer();
  const base = createLegacyWebhookConfigFromEnv(process.env, { jwtIssuer });

  const opaqueSessionVerifier = createOpaqueSessionEndUserVerifier({
    issuer: jwtIssuer,
  });

  return {
    webhookSecret: base.webhookSecret,
    endUserAuth: createFirstMatchEndUserVerifier([
      opaqueSessionVerifier,
      createLegacyOidcVerifierFromEnv(process.env, { jwtIssuer }),
    ]),
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

  return handleAuthorize(request, buildWebhookConfig());
}
