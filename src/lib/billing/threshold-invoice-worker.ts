/**
 * Gathering invoice helpers (legacy threshold-raise path retired).
 * Soft-negative gates allow/deny; invoice-trigger raises OM gathering mid-cycle.
 */
import { gatheringTotalUsdMicros } from "@/lib/billing/unbilled-debt";

export { gatheringTotalUsdMicros };

/** True when any gathering total has reached the threshold (test helper). */
export function gatheringInvoiceMeetsThreshold(
  totals: unknown[],
  thresholdUsdMicros: bigint,
): boolean {
  for (const total of totals) {
    const micros = gatheringTotalUsdMicros(total);
    if (micros != null && micros >= thresholdUsdMicros) {
      return true;
    }
  }
  return false;
}
