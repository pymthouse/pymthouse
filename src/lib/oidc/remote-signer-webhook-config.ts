import type { RemoteSignerWebhookConfig } from "@pymthouse/clearinghouse-identity-webhook/protocol";
import { createEndUserVerifierFromEnv } from "@pymthouse/clearinghouse-identity-webhook/verifiers";
import { OIDC_MOUNT_PATH, getIssuer, getPublicOrigin } from "@/lib/oidc/issuer-urls";
import { buildSignerBalanceCheck } from "@/lib/oidc/signer-balance-gate";

type EnvSource = NodeJS.ProcessEnv | Record<string, string | undefined>;

function trimEnv(env: EnvSource, name: string): string {
  const value = env[name];
  return typeof value === "string" ? value.trim() : "";
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Resolve the OIDC issuer URL from a partial env map (tests) or process.env.
 * Prefer IDENTITY_ISSUER; OIDC_ISSUER remains a legacy alias.
 */
function resolveIssuer(env: EnvSource): string {
  const configured =
    trimEnv(env, "IDENTITY_ISSUER") ||
    trimEnv(env, "OIDC_ISSUER") ||
    trimEnv(env, "NEXTAUTH_URL");
  if (!configured) {
    return getIssuer();
  }
  const normalized = trimTrailingSlash(configured);
  return normalized.endsWith(OIDC_MOUNT_PATH)
    ? normalized
    : `${normalized}${OIDC_MOUNT_PATH}`;
}

/**
 * Fill PymtHouse defaults for the identity-webhook verifier so deployments only
 * need NEXTAUTH_URL (plus WEBHOOK_SECRET). Explicit env values always win.
 */
export function resolveIdentityWebhookEnv(env: EnvSource): Record<string, string | undefined> {
  const next: Record<string, string | undefined> = { ...env };
  const issuer = resolveIssuer(env);

  next.IDENTITY_AUTH_MODE = trimEnv(env, "IDENTITY_AUTH_MODE") || "oidc";
  next.IDENTITY_ISSUER = trimEnv(env, "IDENTITY_ISSUER") || issuer;
  // Package still reads OIDC_ISSUER for JWT iss; keep it aligned with IDENTITY_ISSUER.
  next.OIDC_ISSUER = trimEnv(env, "OIDC_ISSUER") || next.IDENTITY_ISSUER;
  next.OIDC_AUDIENCE = trimEnv(env, "OIDC_AUDIENCE") || next.OIDC_ISSUER;
  next.OIDC_CLIENT_CLAIM = trimEnv(env, "OIDC_CLIENT_CLAIM") || "client_id";
  next.OIDC_SUBJECT_CLAIM = trimEnv(env, "OIDC_SUBJECT_CLAIM") || "external_user_id";
  next.OIDC_SUBJECT_TYPE = trimEnv(env, "OIDC_SUBJECT_TYPE") || "external_user_id";
  next.OIDC_REQUIRED_SCOPES = trimEnv(env, "OIDC_REQUIRED_SCOPES") || "sign:job";

  if (!trimEnv(env, "OIDC_TOKEN_EXCHANGE_BASE_URL")) {
    const fromNextAuth =
      trimEnv(env, "NEXTAUTH_URL") ||
      (env === process.env ? getPublicOrigin() : "");
    if (fromNextAuth) {
      next.OIDC_TOKEN_EXCHANGE_BASE_URL = trimTrailingSlash(fromNextAuth);
    } else {
      try {
        next.OIDC_TOKEN_EXCHANGE_BASE_URL = new URL(issuer).origin;
      } catch {
        /* leave unset */
      }
    }
  }

  return next;
}

/**
 * Build the remote-signer webhook config. Issuer / claim / exchange defaults are
 * applied in {@link resolveIdentityWebhookEnv}; only NEXTAUTH_URL is required
 * in normal PymtHouse deployments.
 */
export function buildRemoteSignerWebhookConfig(
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
): RemoteSignerWebhookConfig {
  const source = resolveIdentityWebhookEnv(env ?? process.env);
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
