import {
  calendarMonthBoundsForYearMonth,
  calendarMonthBoundsUtc,
  listRecentBillingCycleKeys,
  utcYearMonthKey,
} from "@/lib/billing-utils";
import { getOpenMeterClientForApp } from "@/lib/openmeter/client-factory";
import {
  openMeterUsesLiveNetworkInTests,
  requireOpenMeterForUsageReads,
  SIGNED_TICKET_COUNT_METER,
} from "@/lib/openmeter/constants";
import { resolveOpenMeterMeterClientId } from "@/lib/openmeter/meter-client-id";
import { meterRowValueToNumber } from "@/lib/openmeter/usage-read";

type UsageMonthRow = {
  windowStart?: Date | string | null;
  value?: unknown;
};

function monthKeyFromWindow(
  windowStart: Date | string | null | undefined,
): string | null {
  if (!windowStart) return null;
  const date = windowStart instanceof Date ? windowStart : new Date(windowStart);
  if (Number.isNaN(date.getTime())) return null;
  return utcYearMonthKey(date);
}

/**
 * Earliest UTC `YYYY-MM` with a positive signed-ticket count.
 * Empty windows are ignored so the picker starts when usage began.
 */
export function earliestUsageCycleKeyFromRows(rows: readonly UsageMonthRow[]): string | null {
  let earliest: string | null = null;
  for (const row of rows) {
    if (meterRowValueToNumber(row.value) <= 0) continue;
    const key = monthKeyFromWindow(row.windowStart);
    if (!key) continue;
    if (!earliest || key < earliest) earliest = key;
  }
  return earliest;
}

/**
 * One Konnect meter query: `signed_ticket_count` grouped into UTC months
 * for a single app, bounded to the cycle lookback. No per-identity groupBy,
 * so the response is at most one row per month.
 * Returns null when metering is unavailable or the app has no usage yet.
 */
export async function queryEarliestUsageCycleKey(
  appId: string,
  now: Date = new Date(),
): Promise<string | null> {
  const trimmed = appId.trim();
  if (!trimmed || !requireOpenMeterForUsageReads()) return null;
  if (process.env.NODE_ENV === "test" && !openMeterUsesLiveNetworkInTests()) {
    return null;
  }

  const lookback = listRecentBillingCycleKeys(now);
  const oldest = lookback[lookback.length - 1];
  const from = oldest ? calendarMonthBoundsForYearMonth(oldest) : null;
  if (!from) return null;
  const to = calendarMonthBoundsUtc(now);

  try {
    const client = await getOpenMeterClientForApp(trimmed);
    if (!client) return null;
    const meterClientId = await resolveOpenMeterMeterClientId(trimmed);
    const result = await client.meters.query(SIGNED_TICKET_COUNT_METER, {
      from: new Date(from.start),
      to: new Date(to.end),
      windowSize: "MONTH",
      clientId: meterClientId,
      groupBy: ["client_id"],
    });
    return earliestUsageCycleKeyFromRows(result.data ?? []);
  } catch (err) {
    console.warn(
      "usage-cycle-keys: month query failed",
      trimmed,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
