/**
 * Simple in-memory sliding-window rate limiter for public x402 agent endpoints.
 * Not distributed — fine for a single Node instance; replace with Redis later if needed.
 */

type Bucket = {
  timestamps: number[];
};

const buckets = new Map<string, Bucket>();

export function checkRateLimit(input: {
  key: string;
  limit: number;
  windowMs: number;
}): { allowed: boolean; remaining: number; retryAfterMs: number } {
  const now = Date.now();
  const windowStart = now - input.windowMs;
  let bucket = buckets.get(input.key);
  if (!bucket) {
    bucket = { timestamps: [] };
    buckets.set(input.key, bucket);
  }
  bucket.timestamps = bucket.timestamps.filter((t) => t > windowStart);
  if (bucket.timestamps.length >= input.limit) {
    const oldest = bucket.timestamps[0] ?? now;
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: Math.max(0, oldest + input.windowMs - now),
    };
  }
  bucket.timestamps.push(now);
  return {
    allowed: true,
    remaining: Math.max(0, input.limit - bucket.timestamps.length),
    retryAfterMs: 0,
  };
}

/** Test helper. */
export function resetRateLimitsForTests(): void {
  buckets.clear();
}
