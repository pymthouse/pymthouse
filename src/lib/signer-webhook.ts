import {
  createOidcRemoteSignerWebhookConfig,
  type OidcEndUserAuthConfig,
  type RemoteSignerWebhookConfig,
} from "@pymthouse/builder-sdk/signer/webhook";
import { getIssuer } from "@/lib/oidc/issuer-urls";
import { LIVEPEER_REMOTE_SIGNER_AUDIENCE } from "@/lib/oidc/mint-user-signer-token";
import { runSignerWebhookPlatformGating } from "@/lib/signer-webhook-gating";

function envTrim(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value || undefined;
}

export function readPymthouseOidcWebhookConfig(): OidcEndUserAuthConfig {
  const webhookSecret = envTrim("SIGNER_WEBHOOK_SECRET");
  if (!webhookSecret) {
    throw new Error("SIGNER_WEBHOOK_SECRET is required");
  }

  return {
    webhookSecret,
    jwtIssuer: getIssuer(),
    jwtAudience:
      envTrim("SIGNER_WEBHOOK_JWT_AUDIENCE") ?? LIVEPEER_REMOTE_SIGNER_AUDIENCE,
    requiredScopes: ["sign:job"],
    claimMapping: {
      claimClientId: envTrim("SIGNER_WEBHOOK_CLAIM_CLIENT_ID") ?? "client_id",
      claimUsageSubject:
        envTrim("SIGNER_WEBHOOK_CLAIM_USAGE_SUBJECT") ?? "sub",
      usageSubjectType:
        envTrim("SIGNER_WEBHOOK_USAGE_SUBJECT_TYPE") ?? "external_user_id",
    },
    allowInsecureHttp: envTrim("SIGNER_WEBHOOK_ALLOW_INSECURE_HTTP") === "1",
  };
}

export function readPymthouseSignerWebhookConfig(): RemoteSignerWebhookConfig {
  return createOidcRemoteSignerWebhookConfig({
    ...readPymthouseOidcWebhookConfig(),
    afterVerify: runSignerWebhookPlatformGating,
  });
}
