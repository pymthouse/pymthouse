import { sql } from "drizzle-orm";
import { db } from "@/db/index";
import { networkAgentRateBuckets } from "@/db/schema";

const PURGE_BATCH = 64;

export class BucketRateLimitError extends Error {
  constructor() {
    super("Too many requests. Try again shortly.");
    this.name = "BucketRateLimitError";
  }
}

async function purgeExpiredRateBuckets(nowMs: number): Promise<void> {
  await db.execute(sql`
    DELETE FROM network_agent_rate_buckets
    WHERE bucket_key IN (
      SELECT bucket_key FROM network_agent_rate_buckets
      WHERE reset_at_ms <= ${nowMs}
      LIMIT ${PURGE_BATCH}
    )
  `);
}

/** Shared fixed-window counter. Keys must be namespaced by the caller. */
export async function assertBucketRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<void> {
  const nowMs = Date.now();
  await purgeExpiredRateBuckets(nowMs);
  const resetAtMs = nowMs + windowMs;
  const rows = await db
    .insert(networkAgentRateBuckets)
    .values({
      bucketKey: key,
      count: 1,
      resetAtMs,
    })
    .onConflictDoUpdate({
      target: networkAgentRateBuckets.bucketKey,
      set: {
        count: sql`CASE WHEN ${networkAgentRateBuckets.resetAtMs} <= ${nowMs} THEN 1 ELSE ${networkAgentRateBuckets.count} + 1 END`,
        resetAtMs: sql`CASE WHEN ${networkAgentRateBuckets.resetAtMs} <= ${nowMs} THEN ${resetAtMs} ELSE ${networkAgentRateBuckets.resetAtMs} END`,
      },
    })
    .returning({ count: networkAgentRateBuckets.count });
  if ((rows[0]?.count ?? 0) > limit) {
    throw new BucketRateLimitError();
  }
}
