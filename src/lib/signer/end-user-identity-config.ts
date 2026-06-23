import { getIssuer } from "@/lib/oidc/issuer-urls";
import {
  resolveSubjectAccessToken,
  SubjectAccessTokenResolveError,
} from "@/lib/oidc/resolve-subject-access-token";
import { PmtHouseError } from "@pymthouse/builder-sdk";
import {
  createSignerDmzRemoteSignerWebhookConfig,
  type EndUserAuthVerifier,
  type VerifiedEndUserAuth,
  type WebhookIdentityClaimMapping,
} from "@pymthouse/builder-sdk/signer/webhook";

const SUBJECT_ACCESS_TOKEN_KEY = "__subjectAccessToken";

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

function optionalBearerToken(authorization: string): string | null {
  const trimmed = authorization.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) {
    return null;
  }
  const token = trimmed.slice("bearer ".length).trim();
  return token || null;
}

function readClaimMapping(): WebhookIdentityClaimMapping {
  return {
    claimClientId: process.env.CLAIM_CLIENT_ID?.trim() || "client_id",
    claimUsageSubject:
      process.env.CLAIM_USAGE_SUBJECT?.trim() || "external_user_id",
    usageSubjectType:
      process.env.USAGE_SUBJECT_TYPE?.trim() || "external_user_id",
  };
}

function isAppUserIdentity(verified: VerifiedEndUserAuth): boolean {
  if (verified.identity.usage_subject_type === "app_user") {
    return true;
  }
  const raw = verified.raw;
  if (raw != null && typeof raw === "object") {
    return (raw as Record<string, unknown>).user_type === "app_user";
  }
  return false;
}

function readSubjectAccessToken(verified: VerifiedEndUserAuth): string | null {
  const raw = verified.raw;
  if (raw == null || typeof raw !== "object") {
    return null;
  }
  const token = (raw as Record<string, unknown>)[SUBJECT_ACCESS_TOKEN_KEY];
  return typeof token === "string" && token.trim() ? token.trim() : null;
}

export function buildEndUserIdentityConfig(): {
  endUserAuth: EndUserAuthVerifier;
  jwtIssuer: string;
  jwtAudience: string;
  claimMapping: WebhookIdentityClaimMapping;
} {
  const jwtIssuer = process.env.JWT_ISSUER?.trim() || getIssuer();
  const jwtAudience = process.env.JWT_AUDIENCE?.trim() || jwtIssuer;
  const claimMapping = readClaimMapping();
  const allowInsecureHttp =
    boolEnv(process.env.ALLOW_INSECURE_HTTP) || isHttpIssuer(jwtIssuer);

  const { endUserAuth: baseEndUserAuth } = createSignerDmzRemoteSignerWebhookConfig(
    {
      webhookSecret: process.env.WEBHOOK_SECRET?.trim() || "unused",
      jwtIssuer,
      jwtAudience,
      claimMapping,
      allowInsecureHttp,
    },
  );

  const endUserAuth: EndUserAuthVerifier = {
    ...baseEndUserAuth,
    verify: async (ctx) => {
      const verified = await baseEndUserAuth.verify(ctx);
      const token = optionalBearerToken(ctx.authorization);
      if (!token) {
        return verified;
      }
      const raw =
        verified.raw != null && typeof verified.raw === "object"
          ? { ...(verified.raw as Record<string, unknown>) }
          : {};
      raw[SUBJECT_ACCESS_TOKEN_KEY] = token;
      return { ...verified, raw };
    },
  };

  return {
    endUserAuth,
    jwtIssuer,
    jwtAudience,
    claimMapping,
  };
}

export function buildRemoteSignerWebhookConfig() {
  const webhookSecret = process.env.WEBHOOK_SECRET?.trim() || "";
  const identity = buildEndUserIdentityConfig();
  return {
    webhookSecret,
    endUserAuth: identity.endUserAuth,
  };
}

export async function resolveExternalUserIdForUsage(
  verified: VerifiedEndUserAuth,
): Promise<string> {
  if (!isAppUserIdentity(verified)) {
    return verified.identity.usage_subject;
  }

  const token = readSubjectAccessToken(verified);
  if (!token) {
    throw new PmtHouseError("missing subject access token for app_user identity", {
      status: 401,
      code: "invalid_token",
    });
  }

  try {
    const resolved = await resolveSubjectAccessToken(token, {
      expectedPublicClientId: verified.identity.client_id,
    });
    return resolved.externalUserId;
  } catch (err) {
    if (err instanceof SubjectAccessTokenResolveError) {
      throw new PmtHouseError(err.message, {
        status: err.status,
        code: err.code,
      });
    }
    throw err;
  }
}
