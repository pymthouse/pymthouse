/**
 * Soft-negative + overage decision for mint / live signer gates.
 */
import {
  effectiveSoftNegativeUsdMicros,
  softNegativeAllowsContinue,
} from "@/lib/billing/overage-limits";
import type { BillingReason } from "@/lib/billing/billing-state";
import { getUnbilledDebtUsdMicros } from "@/lib/billing/unbilled-debt";
import { getAppBillingConfig } from "@/lib/openmeter/billing-profiles";
import { resolveOpenMeterMeterClientId } from "@/lib/openmeter/meter-client-id";
import { getProviderApp } from "@/lib/provider-apps";
import { sanitizeForLog } from "@/lib/sanitize-for-log";

export async function resolveSoftNegativeGate(input: {
  clientId: string;
  externalUserId: string;
  spendableUsdMicros: bigint;
  allowsOverageInvoicing: boolean;
}): Promise<{
  allow: boolean;
  unbilledDebtUsdMicros: bigint;
  softNegativeUsdMicros: bigint;
}> {
  if (input.spendableUsdMicros > 0n) {
    return {
      allow: true,
      unbilledDebtUsdMicros: 0n,
      softNegativeUsdMicros: 0n,
    };
  }
  if (!input.allowsOverageInvoicing) {
    return {
      allow: false,
      unbilledDebtUsdMicros: 0n,
      softNegativeUsdMicros: 0n,
    };
  }

  let config: { softNegativeUsdMicros?: string | null } | null = null;
  try {
    const app = await getProviderApp(input.clientId);
    const appId =
      app?.id?.trim() ||
      (await resolveOpenMeterMeterClientId(input.clientId).catch(() =>
        input.clientId.trim(),
      ));
    config = await getAppBillingConfig(appId);
  } catch (err) {
    // Unknown ceiling is not a ceiling. A billing outage must not lock out
    // an overage-eligible subject — same fail-open as the debt lookup.
    console.warn(
      `[soft-negative-gate] billing config lookup failed client_id=${sanitizeForLog(input.clientId)} subject=${sanitizeForLog(input.externalUserId)}:`,
      sanitizeForLog(err),
    );
  }
  const softNegativeUsdMicros = effectiveSoftNegativeUsdMicros(
    config?.softNegativeUsdMicros,
  );
  // No positive ceiling → skip debt lookup; overage alone unlocks past $0.
  if (softNegativeUsdMicros <= 0n) {
    return {
      allow: true,
      unbilledDebtUsdMicros: 0n,
      softNegativeUsdMicros,
    };
  }

  let unbilledDebtUsdMicros: bigint;
  try {
    unbilledDebtUsdMicros = await getUnbilledDebtUsdMicros({
      clientId: input.clientId,
      externalUserId: input.externalUserId,
    });
  } catch (err) {
    // Unknown debt is not debt. A billing outage must not lock out an
    // overage-eligible subject — the same fail-open stance as the read
    // surfaces and the owner PM lookup — so treat it as 0 and let the
    // invoice trigger / daily sweep catch up once billing is back.
    console.warn(
      `[soft-negative-gate] unbilled debt lookup failed client_id=${sanitizeForLog(input.clientId)} subject=${sanitizeForLog(input.externalUserId)}:`,
      sanitizeForLog(err),
    );
    unbilledDebtUsdMicros = 0n;
  }
  const allow = softNegativeAllowsContinue({
    spendableUsdMicros: input.spendableUsdMicros,
    allowsOverageInvoicing: input.allowsOverageInvoicing,
    unbilledDebtUsdMicros,
    softNegativeUsdMicros,
  });
  return { allow, unbilledDebtUsdMicros, softNegativeUsdMicros };
}

/**
 * Why a denied gate said no, in the same vocabulary as `billingState.reason`.
 * Hitting the ceiling, lacking a card, and a plan that cannot overage are
 * different problems — the 483 wire only carries the message, so the reason
 * must pick the right BILLING_REASON_MESSAGE.
 */
export function softNegativeDenyReason(input: {
  allowsOverageInvoicing: boolean;
  unbilledDebtUsdMicros: bigint;
  softNegativeUsdMicros: bigint;
  /** When overage is closed: false → no card; otherwise plan/mode cannot overage. */
  hasDefaultPaymentMethod?: boolean | null;
}): BillingReason {
  if (!input.allowsOverageInvoicing) {
    return input.hasDefaultPaymentMethod === false
      ? "no_payment_method"
      : "overage_not_available";
  }
  return input.softNegativeUsdMicros > 0n &&
    input.unbilledDebtUsdMicros >= input.softNegativeUsdMicros
    ? "debt_ceiling_reached"
    : "overage_not_available";
}
