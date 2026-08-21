/**
 * Daily metered spend for a set of OpenMeter subjects.
 *
 * OpenMeter exposes no per-event consumption feed, so the transactions ledger
 * synthesizes credit drawdowns from `DAY`-windowed network-fee meter rows.
 * Shared by the owner wallet ledger and the merchant end-user ledger.
 */
import type { OpenMeter } from "@openmeter/sdk";

import type { LedgerDailyUsageInput } from "@/lib/billing/transactions-ledger";
import { NETWORK_FEE_USD_MICROS_METER } from "@/lib/openmeter/constants";
import {
  dateKeyFromMeterWindow,
  meterRowValueToBigInt,
} from "@/lib/openmeter/usage-read";
import { sanitizeForLog } from "@/lib/sanitize-for-log";

/**
 * Sum the network-fee meter by UTC day, ascending.
 *
 * A meter failure degrades to an empty series rather than throwing: the ledger
 * flags itself incomplete instead of failing the whole wallet request.
 */
export async function querySubjectDailyFeeUsage(input: {
  client: OpenMeter;
  subjects: string[];
  /** ISO instant, inclusive. */
  start: string;
  /** ISO instant, exclusive. */
  end: string;
  /** Log prefix identifying the calling surface. */
  logLabel: string;
  /** Optional callback when the meter query degrades to fallback. */
  onDegraded?: () => void;
}): Promise<LedgerDailyUsageInput[]> {
  const subjects = [...new Set(input.subjects.map((s) => s.trim()).filter(Boolean))];
  if (subjects.length === 0) {
    return [];
  }

  try {
    const feeResult = await input.client.meters.query(NETWORK_FEE_USD_MICROS_METER, {
      windowSize: "DAY" as const,
      from: new Date(input.start),
      to: new Date(input.end),
      subject: subjects,
    });

    const byDay = new Map<string, bigint>();
    for (const row of feeResult.data || []) {
      const dateKey = dateKeyFromMeterWindow(row);
      if (!dateKey) continue;
      byDay.set(dateKey, (byDay.get(dateKey) ?? 0n) + meterRowValueToBigInt(row.value));
    }

    return [...byDay.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, used]) => ({ date, usedUsdMicros: used.toString() }));
  } catch (err) {
    input.onDegraded?.();
    console.warn(
      `${input.logLabel}: daily meter query failed`,
      sanitizeForLog(subjects.join(",")),
      sanitizeForLog(err instanceof Error ? err.message : String(err)),
    );
    return [];
  }
}
