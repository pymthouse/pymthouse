/**
 * Builder + End-user API v2 surface — the single source of truth for which v1
 * contract operations are served under `/api/v2`, which are guarded, and which
 * exist only in v2.
 *
 * - **Aliased:** every v1 Builder / End-user contract operation (`tags.ts`) not
 *   listed below. `scripts/generate-api-v2-aliases.ts` writes method-exact
 *   re-export route files under `src/app/api/v2/**`.
 * - **Guarded:** owner-wallet routes that also accept a merchant end-user via
 *   `externalUserId`. v2 serves them through hand-written wrappers
 *   (`withoutSubjectOverride`) so M2M can only act on the owner wallet.
 * - **Excluded:** legacy M2M operations that name the billed end user. v2
 *   replaces them with `/apps/{clientId}/me/billing/*` (end-user Bearer).
 * - **Native:** v2-only operations with their own route files.
 *
 * Pure data — imported by `tags.ts`, route scanning, and generator scripts.
 */

export const API_V1_PREFIX = "/api/v1";
export const API_V2_PREFIX = "/api/v2";

export type ApiVersion = "v1" | "v2";

/** Public API reference (Scalar, v2 by default with a v1 picker). */
export const API_REFERENCE_URL = `${API_V2_PREFIX}/docs`;

export function apiVersionOfPath(path: string): ApiVersion | null {
  if (path === API_V1_PREFIX || path.startsWith(`${API_V1_PREFIX}/`)) {
    return "v1";
  }
  if (path === API_V2_PREFIX || path.startsWith(`${API_V2_PREFIX}/`)) {
    return "v2";
  }
  return null;
}

/** `/api/v1/…` → `/api/v2/…`. Other paths are returned unchanged. */
export function toV2Path(path: string): string {
  return apiVersionOfPath(path) === "v1"
    ? `${API_V2_PREFIX}${path.slice(API_V1_PREFIX.length)}`
    : path;
}

/** `/api/v2/…` → `/api/v1/…`. Other paths are returned unchanged. */
export function toV1Path(path: string): string {
  return apiVersionOfPath(path) === "v2"
    ? `${API_V1_PREFIX}${path.slice(API_V2_PREFIX.length)}`
    : path;
}

/** `"GET /api/v1/…"` → `"GET /api/v2/…"`. */
export function toV2OperationKey(key: string): string {
  const space = key.indexOf(" ");
  return `${key.slice(0, space)} ${toV2Path(key.slice(space + 1))}`;
}

/** v2 end-user billing path for a successor `Link` (`{clientId}` substituted when known). */
export function meBillingV2Path(clientId: string, suffix = ""): string {
  return `${API_V2_PREFIX}/apps/${encodeURIComponent(clientId)}/me/billing${suffix}`;
}

export type V2ExcludedOperation = {
  /** Why the operation is not in v2 (shown in the v1 doc). */
  reason: string;
  /** v2 `/me/billing` successor suffix, when one exists (or will in A2). */
  meBillingSuccessor?: string;
};

/** v1 contract operations that are not served under `/api/v2`. */
export const V2_EXCLUDED_V1_OPERATIONS: ReadonlyMap<string, V2ExcludedOperation> =
  new Map<string, V2ExcludedOperation>([
    [
      "POST /api/v1/apps/{clientId}/users/{externalUserId}/payment-methods",
      {
        reason: "M2M names the billed end user in the path.",
        meBillingSuccessor: "/payment-methods",
      },
    ],
    [
      "POST /api/v1/apps/{clientId}/billing/checkout",
      {
        reason: "M2M names the billed end user in the body.",
        meBillingSuccessor: "/checkout",
      },
    ],
    [
      "POST /api/v1/apps/{clientId}/users/{externalUserId}/allowances",
      { reason: "v1 tombstone: free credit grants are admin-only (always 403)." },
    ],
    [
      "POST /api/v1/oidc/token",
      { reason: "OIDC issuer protocol endpoint; the issuer stays on /api/v1." },
    ],
  ]);

/**
 * v1 contract operations served in v2 by a hand-written wrapper that rejects
 * `externalUserId` / `external_user_id` / `userId` (owner wallet only).
 * Value = `/me/billing` successor suffix for the `Link` header.
 */
export const V2_GUARDED_V1_OPERATIONS: ReadonlyMap<string, string> = new Map([
  ["GET /api/v1/apps/{clientId}/billing/wallet", "/wallet"],
  ["PATCH /api/v1/apps/{clientId}/billing/wallet", "/wallet"],
  ["POST /api/v1/apps/{clientId}/billing/wallet/top-up", "/wallet/top-up"],
  ["GET /api/v1/apps/{clientId}/billing/wallet/invoices", "/invoices"],
  ["GET /api/v1/apps/{clientId}/billing/wallet/payment-methods", "/payment-methods"],
  ["POST /api/v1/apps/{clientId}/billing/wallet/payment-methods", "/payment-methods"],
  ["GET /api/v1/apps/{clientId}/billing/state", "/state"],
]);

/**
 * Aliased operations that intentionally keep a query/body `externalUserId`
 * (platform / merchant ops, not end-user self-serve — see #464 Pack B).
 */
export const V2_ALIAS_SUBJECT_PARAM_ALLOWED: ReadonlySet<string> = new Set([
  "POST /api/v1/apps/{clientId}/billing/collect",
]);

/** End-user operations that exist only under `/api/v2`. */
export const V2_NATIVE_END_USER_OPERATION_KEYS: ReadonlySet<string> = new Set([
  "GET /api/v2/apps/{clientId}/me/billing/allowances",
  "GET /api/v2/apps/{clientId}/me/billing/wallet",
  "GET /api/v2/apps/{clientId}/me/billing/state",
  "GET /api/v2/apps/{clientId}/me/billing/invoices",
  "GET /api/v2/apps/{clientId}/me/billing/payment-methods",
  "GET /api/v2/apps/{clientId}/me/billing/subscription",
]);

/**
 * v2 keys for a set of v1 contract keys: excluded operations dropped,
 * everything else (aliased + guarded) mapped onto `/api/v2`.
 */
export function deriveV2OperationKeys(v1Keys: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const key of v1Keys) {
    if (V2_EXCLUDED_V1_OPERATIONS.has(key)) {
      continue;
    }
    out.add(toV2OperationKey(key));
  }
  return out;
}
