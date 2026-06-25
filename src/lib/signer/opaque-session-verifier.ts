import { eq } from "drizzle-orm";
import { db } from "@/db/index";
import { endUsers } from "@/db/schema";
import { hasScope, validateBearerToken } from "@/lib/auth";
import {
  bearerTokenFromAuthorization,
  type EndUserAuthVerifier,
  type UsageIdentity,
} from "@pymthouse/builder-sdk/signer/webhook";

/**
 * Opaque `pmth_*` remote-signer session acceptance for the remote-signer
 * identity webhook.
 *
 * Context: the signer DMZ forwards the end-user `Authorization: Bearer …` to
 * this webhook (`/webhooks/remote-signer`) so go-livepeer can attribute a
 * billable `/generate-live-payment` ticket to `(client_id, external_user_id)`.
 * The OIDC verifier only accepts signer **JWTs** (`aud = issuer`, JWKS-verifiable),
 * so an opaque `pmth_…` remote-signer session — minted via the RFC 8693 gateway
 * exchange (no `resource`, see `handleGatewayTokenExchange`) — is rejected with
 * "Invalid JWT". The unbilled `/sign-orchestrator-info` path already works from
 * that opaque session, so payment was the only asymmetric gate.
 *
 * This verifier closes that gap symmetrically: it validates the opaque session
 * **against PymtHouse** (the same `validateBearerToken` session lookup the rest
 * of the API relies on — not blind trust) and derives the identical attribution
 * identity the signer JWT would have carried:
 *   - `issuer`             ← the OIDC issuer
 *   - `client_id`          ← the session's public app client id (`sessions.app_id`)
 *   - `usage_subject`      ← the end user's `external_user_id`
 *   - `usage_subject_type` ← `external_user_id`
 *
 * It is strictly **additive**: only opaque `pmth_` bearers are handled here; any
 * other bearer is passed through (by throwing) so the composite verifier falls
 * back to the unchanged JWT / trusted-headers paths.
 */

const OPAQUE_SESSION_PREFIX = "pmth_";
const DEFAULT_REQUIRED_SCOPE = "sign:job";
const DEFAULT_EXPIRY_TTL_SECONDS = 300;
const USAGE_SUBJECT_TYPE = "external_user_id";

/** Attribution principal resolved from a validated opaque session. */
export type OpaqueSessionPrincipal = {
  /** Public app client id used as the billing `client_id`. */
  clientId: string;
  /** End-user attribution subject (the app's external user id). */
  externalUserId: string;
};

export type OpaqueSessionEndUserVerifierConfig = {
  /** OIDC issuer URL; emitted verbatim (trailing slashes stripped) as `identity.issuer`. */
  issuer: string;
  /** Scope the session must carry to authorize signing. Defaults to `sign:job`. */
  requiredScope?: string;
  /** Auth-cache TTL (seconds) returned to go-livepeer. Defaults to 300. */
  expiryTtlSeconds?: number;
  /**
   * Resolve a validated opaque session to its attribution principal. Injectable
   * for tests; defaults to a PymtHouse session lookup (`validateBearerToken`)
   * plus an `end_users.external_user_id` resolution.
   */
  resolvePrincipal?: (token: string) => Promise<OpaqueSessionPrincipal | null>;
};

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") {
    end -= 1;
  }
  return value.slice(0, end);
}

/**
 * Default principal resolver: validate the opaque session against PymtHouse and
 * map it to `(client_id, external_user_id)`. Returns `null` for any session that
 * is unknown, expired, missing the required scope, or not bound to both a
 * developer app and an end user (i.e. not attributable for billing).
 */
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
  // Billable attribution requires a public app client id and an end user.
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

/**
 * Build an {@link EndUserAuthVerifier} that authorizes opaque `pmth_*`
 * remote-signer sessions. Intended to be composed (via
 * `createFirstMatchEndUserVerifier`) ahead of the JWT / trusted-headers
 * verifiers so the JWT path stays the default and remains unchanged.
 */
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
    kind: "custom",
    verify: async ({ authorization }) => {
      const token = bearerTokenFromAuthorization(authorization);
      // Only handle opaque sessions; let other bearers (JWTs) fall through to
      // the next verifier in the composite chain.
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
