const WINDOW_MS = 60_000;
const MAX_REGISTRATIONS_PER_WINDOW = 10;

type Bucket = {
  resetAt: number;
  count: number;
};

const buckets = new Map<string, Bucket>();

export function dcrRegistrationClientKey(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim();
  return ip || headers.get("x-real-ip")?.trim() || "unknown";
}

export function consumeDcrRegistrationSlot(clientKey: string): boolean {
  const now = Date.now();
  const existing = buckets.get(clientKey);
  if (!existing || existing.resetAt <= now) {
    buckets.set(clientKey, { resetAt: now + WINDOW_MS, count: 1 });
    return true;
  }
  if (existing.count >= MAX_REGISTRATIONS_PER_WINDOW) {
    return false;
  }
  existing.count += 1;
  return true;
}

export function resetDcrRegistrationRateLimitForTests(): void {
  buckets.clear();
}
