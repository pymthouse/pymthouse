import { eq } from "drizzle-orm";
import { db } from "@/db/index";
import { endUsers } from "@/db/schema";
import { hasScope, validateBearerToken } from "@/lib/auth";
import {
  bearerToken,
  type EndUserAuthVerifier,
  type UsageIdentity,
} from "@pymthouse/clearinghouse-identity-webhook/protocol";

/**
 * Opaque `pmth_*` remote-signer session acceptance for the remote-signer
 * identity webhook.
 *
 * The OIDC verifier only accepts signer JWTs (`aud = issuer`, JWKS-verifiable),
 * so an opaque `pmth_…` remote-signer session is rejected with "Invalid JWT".
 * `/sign-orchestrator-info` already works from that opaque session; payment was
 * the only asymmetric gate.
 */

const OPAQUE_SESSION_PREFIX = "pmth_";
const DEFAULT_REQUIRED_SCOPE = "sign:job";
const DEFAULT_EXPIRY_TTL_SECONDS = 300;
const USAGE_SUBJECT_TYPE = "external_user_id";

export type OpaqueSessionPrincipal = {
  clientId: string;
  externalUserId: string;
};

export type OpaqueSessionEndUserVerifierConfig = {
  issuer: string;
  requiredScope?: string;
  expiryTtlSeconds?: number;
  resolvePrincipal?: (token: string) => Promise<OpaqueSessionPrincipal | null>;
};

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") {
    end -= 1;
  }
  return value.slice(0, end);
}

async function resolvePrincipalFromSession(
  token: string,
  requiredScope: string,
): Promise<OpaqueSessionPrincipal | null> {
  const auth = await validateBearerToken(token);
  if (!auth) {
    return null;
  }
  if (!hasScope(auth.scopes, requiredScope)) {
    return null;
  }
  if (!auth.appId || !auth.endUserId) {
    return null;
  }

  const rows = await db
    .select({ externalUserId: endUsers.externalUserId })
    .from(endUsers)
    .where(eq(endUsers.id, auth.endUserId))
    .limit(1);
  const externalUserId = rows[0]?.externalUserId?.trim();
  if (!externalUserId) {
    return null;
  }

  return { clientId: auth.appId.trim(), externalUserId };
}

export function createOpaqueSessionEndUserVerifier(
  config: OpaqueSessionEndUserVerifierConfig,
): EndUserAuthVerifier {
  const issuer = stripTrailingSlashes(config.issuer.trim());
  if (!issuer) {
    throw new Error("issuer is required for opaque session verification");
  }
  const requiredScope = config.requiredScope?.trim() || DEFAULT_REQUIRED_SCOPE;
  const expiryTtlSeconds =
    config.expiryTtlSeconds && config.expiryTtlSeconds > 0
      ? Math.trunc(config.expiryTtlSeconds)
      : DEFAULT_EXPIRY_TTL_SECONDS;
  const resolvePrincipal =
    config.resolvePrincipal ??
    ((token: string) => resolvePrincipalFromSession(token, requiredScope));

  return {
    kind: "opaque_session",
    verify: async ({ authorization }) => {
      const token = bearerToken(authorization);
      if (!token.startsWith(OPAQUE_SESSION_PREFIX)) {
        throw new Error("not an opaque remote-signer session");
      }

      const principal = await resolvePrincipal(token);
      if (!principal) {
        throw new Error("invalid or unauthorized remote-signer session");
      }

      const identity: UsageIdentity = {
        issuer,
        client_id: principal.clientId,
        usage_subject: principal.externalUserId,
        usage_subject_type: USAGE_SUBJECT_TYPE,
      };

      return {
        identity,
        expiry: Math.trunc(Date.now() / 1000) + expiryTtlSeconds,
      };
    },
  };
}
