import {
  applyRetailRateToNetworkMicros,
  defaultRetailRateUsd,
  parseRetailRateUsd,
  retailRateUsdToMarkupPercent,
} from "@pymthouse/builder-sdk";

export { applyRetailRateToNetworkMicros };

export function resolveEffectiveRetailRateUsd(input: {
  capabilityRetailRateUsd: string | null | undefined;
  planOverageRateUsd: string | null | undefined;
}): string {
  return (
    parseRetailRateUsd(input.capabilityRetailRateUsd) ??
    parseRetailRateUsd(input.planOverageRateUsd) ??
    defaultRetailRateUsd()
  );
}

export function markupPercentForRetailRate(retailRateUsd: string): string | null {
  const pct = retailRateUsdToMarkupPercent(retailRateUsd);
  return pct === "" ? null : pct;
}
