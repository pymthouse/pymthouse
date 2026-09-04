import { NextResponse } from "next/server";

import {
  isValidBoundedDateRange,
  MAX_DATE_RANGE_DAYS,
} from "@/lib/billing-utils";

/**
 * Optional date range for signed-ticket history. Both bounds are required
 * together and are span-limited before hitting OpenMeter.
 */
export function parseOptionalDateRange(
  params: URLSearchParams,
): { error: NextResponse } | { from?: string; to?: string } {
  const from = params.get("from")?.trim() || undefined;
  const to = params.get("to")?.trim() || undefined;
  if ((from && !to) || (to && !from)) {
    return {
      error: NextResponse.json(
        { error: "from and to must be supplied together" },
        { status: 400 },
      ),
    };
  }
  if (from && to && !isValidBoundedDateRange(from, to)) {
    return {
      error: NextResponse.json(
        {
          error: `Invalid range; supply from <= to within ${MAX_DATE_RANGE_DAYS} days`,
        },
        { status: 400 },
      ),
    };
  }
  return {
    from,
    to,
  };
}
