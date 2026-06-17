/**
 * BPP ② `validate` response assembly.
 *
 * Centralizes how `/api/v1/auth/validate` builds its success body so the
 * provider-neutral seam invariant is enforced in one place: the provider-internal
 * OpenMeter subscription id is NEVER returned directly — it is encoded into a
 * neutral, opaque `subscriptionRef` (see `subscription-ref.ts`). Conforms to
 * `contracts/billing-provider-protocol/validate.schema.json`.
 */

import { toSubscriptionRef } from "./subscription-ref";

export interface BuildValidateResponseInput {
  /** Public, app-facing client id (already neutral — not an OpenMeter id). */
  clientId: string;
  /** Plan view (already string-normalized) or `null` for free/no-plan keys. */
  plan?: Record<string, unknown> | null;
  /** Generic allowed model ids for the resolved plan. */
  allowedModels: string[];
  /**
   * Provider-internal OpenMeter subscription id, when resolved. Encoded to a
   * neutral `subscriptionRef`; the raw id never appears in the response.
   */
  openmeterSubscriptionId?: string | null;
}

/** Build the neutral `validate` success body (no provider-internal id leaks). */
export function buildValidateResponseBody(
  input: BuildValidateResponseInput,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    valid: true,
    client_id: input.clientId,
    plan: input.plan ?? null,
    allowedModels: input.allowedModels,
  };

  const subscriptionRef = toSubscriptionRef(input.openmeterSubscriptionId);
  if (subscriptionRef) {
    body.subscriptionRef = subscriptionRef;
  }

  return body;
}
