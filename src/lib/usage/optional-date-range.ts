import {
  isValidBoundedDateRange,
  MAX_DATE_RANGE_DAYS,
} from "@/lib/billing-utils";

export type ParsedOptionalDateRange =
  | { error: string }
  | { from?: string; to?: string };

/**
 * Optional `from`/`to` query pair for signed-ticket history.
 * Both bounds are required together and span-limited before OpenMeter.
 */
export function parseOptionalDateRange(
  params: URLSearchParams,
): ParsedOptionalDateRange {
  const from = params.get("from")?.trim() || undefined;
  const to = params.get("to")?.trim() || undefined;
  if ((from && !to) || (to && !from)) {
    return { error: "from and to must be supplied together" };
  }
  if (from && to && !isValidBoundedDateRange(from, to)) {
    return {
      error: `Invalid range; supply from <= to within ${MAX_DATE_RANGE_DAYS} days`,
    };
  }
  return { from, to };
}
