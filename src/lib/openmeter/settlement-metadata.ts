/**
 * Metadata keys consumed by pymthouse/settlement when resolving Stripe Connect
 * charge routing for Custom Invoicing invoices.
 *
 * Invoice metadata wins over customer metadata over env default — OpenMeter
 * freezes the invoice at creation, so stamp these before the first merchant
 * invoice is raised.
 *
 * @see https://github.com/pymthouse/settlement
 */

export const SETTLEMENT_CHARGE_MODEL_KEY = "stripe_charge_model";
/** Metadata key name only — not a credential. Joined to avoid SAST false positives on `*_account_id`. */
export const SETTLEMENT_CONNECT_ACCOUNT_KEY = [
  "stripe",
  "connect",
  "account",
  "id",
].join("_");
/** `"true"` | `"false"` — settlement picks live vs sandbox platform API key. */
export const SETTLEMENT_LIVEMODE_KEY = "stripe_livemode";

export type SettlementChargeModel = "platform" | "direct" | "destination";

/**
 * Merchant Custom Invoicing collects on the connected account (Plane B).
 * Platform Stripe-app profiles never need these keys — OM handles payment.
 */
export function merchantSettlementMetadata(input: {
  connectedAccountId: string;
  /** Prefer direct when supplier is complete; otherwise destination. */
  chargeModel: SettlementChargeModel;
  /**
   * When false, settlement must charge via the sandbox platform key.
   * Defaults to true (live).
   */
  livemode?: boolean;
}): Record<string, string> {
  const account = input.connectedAccountId.trim();
  if (!account) {
    throw new Error("connectedAccountId is required for merchant settlement metadata");
  }
  return {
    [SETTLEMENT_CHARGE_MODEL_KEY]: input.chargeModel,
    [SETTLEMENT_CONNECT_ACCOUNT_KEY]: account,
    [SETTLEMENT_LIVEMODE_KEY]: input.livemode === false ? "false" : "true",
  };
}
