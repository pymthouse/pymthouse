/**
 * Soft-negative + overage decision for mint / live signer gates.
 */
import {
  effectiveSoftNegativeUsdMicros,
  softNegativeAllowsContinue,
} from "@/lib/billing/auto-topup-settings";
import { getUnbilledDebtUsdMicros } from "@/lib/billing/unbilled-debt";
import { getAppBillingConfig } from "@/lib/openmeter/billing-profiles";
import { resolveOpenMeterMeterClientId } from "@/lib/openmeter/meter-client-id";
import { getProviderApp } from "@/lib/provider-apps";

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

  const app = await getProviderApp(input.clientId);
  const appId =
    app?.id?.trim() ||
    (await resolveOpenMeterMeterClientId(input.clientId).catch(() =>
      input.clientId.trim(),
    ));
  const config = await getAppBillingConfig(appId);
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

  const unbilledDebtUsdMicros = await getUnbilledDebtUsdMicros({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });
  const allow = softNegativeAllowsContinue({
    spendableUsdMicros: input.spendableUsdMicros,
    allowsOverageInvoicing: input.allowsOverageInvoicing,
    unbilledDebtUsdMicros,
    softNegativeUsdMicros,
  });
  return { allow, unbilledDebtUsdMicros, softNegativeUsdMicros };
}
