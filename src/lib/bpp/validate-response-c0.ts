/**
 * BPP ② `validate` — C0-conformant response assembly (PYMT-3).
 *
 * This is the fully reshaped, provider-NEUTRAL `validate` body that conforms to
 * `contracts/billing-provider-protocol/validate.schema.json`. It is the target
 * shape for the NaaP front door (NAAP-C) and the C0 conformance suite.
 *
 * Differences vs the removed legacy validate builder:
 *  - identity is surfaced as neutral `user.sub` + a `billing_account` ref instead
 *    of the public, metering-coupled `client_id` (⑨ forbidden field name);
 *  - capabilities are generic `"<pipeline>:<model>"` ids (or the `["*"]` wildcard)
 *    instead of bare `allowedModels` model ids;
 *  - the response carries ONLY C0-allowed top-level fields (`additionalProperties:
 *    false` in the schema) — no `plan`, no `client_id`, no `allowedModels`.
 *
 * The provider-internal OpenMeter subscription id is NEVER returned directly — it
 * is encoded into a neutral, opaque `subscriptionRef` (see `subscription-ref.ts`),
 * exactly as in the legacy builder.
 */

import { toSubscriptionRef } from "./subscription-ref";
import { assertNoLeakedInternalFieldNames } from "./forbidden-fields";

/** Generic capability wildcard — grants all capabilities the plan allows. */
export const CAPABILITY_WILDCARD = "*";

export type BillingMode = "delegated" | "prepay";

export interface C0BillingAccount {
  /** Neutral, app-facing account-of-record id (NOT a provider-internal id). */
  id: string;
  /** Stable provider slug (e.g. `"pymthouse"`). */
  providerSlug: string;
  /** Billing posture for the account. */
  billingMode: BillingMode;
}

export interface C0Quota {
  /** Remaining metered units. */
  remaining: number;
  /** Optional ISO-8601 reset instant. */
  resetAt?: string;
}

export interface C0SignerSession {
  url: string;
  headers: Record<string, string>;
}

export interface BuildC0ValidateResponseInput {
  /** Stable, neutral subject identifier for the resolved user. */
  sub: string;
  /** Provider-neutral billing account of record. */
  billingAccount: C0BillingAccount;
  /**
   * Generic capability ids in the form `"<pipeline>:<model>"` / `"tool:<name>"`,
   * or the single-element wildcard `["*"]`. Empty array is allowed (no caps).
   */
  capabilities: string[];
  /** Remaining quota, or `null`/omitted when not metered/unbounded. */
  quota?: C0Quota | null;
  /**
   * Provider-internal OpenMeter subscription id, when resolved. Encoded to a
   * neutral `subscriptionRef`; the raw id never appears in the response.
   */
  openmeterSubscriptionId?: string | null;
  /** OPTIONAL provider-issued signer session (opaque-to-apps headers). */
  signerSession?: C0SignerSession;
}

/**
 * Build the C0-conformant `validate` success body. The returned object contains
 * only schema-allowed top-level keys, and is asserted free of provider-internal
 * field names before it is returned (defense in depth at the producing edge).
 */
export function buildC0ValidateResponseBody(
  input: BuildC0ValidateResponseInput,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    valid: true,
    user: { sub: input.sub },
    billing_account: {
      id: input.billingAccount.id,
      providerSlug: input.billingAccount.providerSlug,
      billingMode: input.billingAccount.billingMode,
    },
    capabilities: input.capabilities,
    // C0 allows `null` for unmetered/unbounded; delegated MVP is unmetered.
    quota: input.quota ?? null,
  };

  const subscriptionRef = toSubscriptionRef(input.openmeterSubscriptionId);
  if (subscriptionRef) {
    body.subscriptionRef = subscriptionRef;
  }

  if (input.signerSession) {
    body.signerSession = {
      url: input.signerSession.url,
      headers: input.signerSession.headers,
    };
  }

  // Defense in depth: the C0 ② seam must never carry a provider-internal field
  // NAME (e.g. `client_id`, `openmeter_subscription_id`, `model_id`).
  assertNoLeakedInternalFieldNames(body, "validate C0 response");
  return body;
}

/**
 * Map plan capability bundles to generic `"<pipeline>:<model>"` capability ids.
 * Rows missing either part are skipped. Returns a de-duplicated, sorted list.
 */
export function toCapabilityIds(
  bundles: Array<{ pipeline: string | null; modelId: string | null }>,
): string[] {
  const ids = new Set<string>();
  for (const bundle of bundles) {
    const pipeline = bundle.pipeline?.trim();
    const modelId = bundle.modelId?.trim();
    if (pipeline && modelId) {
      ids.add(`${pipeline}:${modelId}`);
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}
