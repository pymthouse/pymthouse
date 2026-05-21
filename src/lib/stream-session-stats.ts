import { db } from "@/db/index";
import { transactions } from "@/db/schema";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";

/**
 * Confirmed usage rows per stream session (source of truth for payment count;
 * reconciles with `stream_sessions.signer_payment_count` when it lags).
 */
export async function confirmedUsageCountByStreamSessionId(
  streamSessionIds: readonly string[],
): Promise<Map<string, number>> {
  if (streamSessionIds.length === 0) return new Map();
  const uniq = [...new Set(streamSessionIds)];
  const rows = await db
    .select({
      streamSessionId: transactions.streamSessionId,
      n: sql<number>`count(*)::int`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.type, "usage"),
        eq(transactions.status, "confirmed"),
        isNotNull(transactions.streamSessionId),
        inArray(transactions.streamSessionId, uniq),
      ),
    )
    .groupBy(transactions.streamSessionId);

  const m = new Map<string, number>();
  for (const r of rows) {
    if (r.streamSessionId != null) m.set(r.streamSessionId, r.n);
  }
  return m;
}
