/** Calendar month bounds in UTC as ISO strings (matches billing cycle fallback). */
export function calendarMonthBoundsUtc(now: Date): { start: string; end: string } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const start = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59, 999));
  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
}


const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Safety limit for inclusive date-range iteration / API query spans. */
export const MAX_DATE_RANGE_DAYS = 365;

/**
 * Inclusive UTC calendar-day span between two ISO timestamps (noon-anchored).
 * `null` when either bound is unparseable or `start > end`.
 */
export function inclusiveUtcDaySpan(
  startDate: string,
  endDate: string,
): number | null {
  const startMs = Date.parse(startDate);
  const endMs = Date.parse(endDate);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || startMs > endMs) {
    return null;
  }
  return (
    Math.floor(
      (new Date(`${endDate.slice(0, 10)}T12:00:00.000Z`).getTime() -
        new Date(`${startDate.slice(0, 10)}T12:00:00.000Z`).getTime()) /
        MS_PER_DAY,
    ) + 1
  );
}

/**
 * True when both bounds parse and `start <= end` within {@link MAX_DATE_RANGE_DAYS}.
 * Used by identity/usage routes before hitting OpenMeter.
 */
export function isValidBoundedDateRange(
  startDate: string,
  endDate: string,
): boolean {
  const daySpan = inclusiveUtcDaySpan(startDate, endDate);
  return daySpan != null && daySpan > 0 && daySpan <= MAX_DATE_RANGE_DAYS;
}

/**
 * Clamp an oversize `[from, to]` so the inclusive UTC day span is at most
 * {@link MAX_DATE_RANGE_DAYS}. Invalid bounds (`from > to`, unparseable) return
 * `null`. Already-valid ranges are returned unchanged.
 */
export function clampDateRangeToMaxDays(
  from: string,
  to: string,
): { from: string; to: string } | null {
  const daySpan = inclusiveUtcDaySpan(from, to);
  if (daySpan == null || daySpan <= 0) {
    return null;
  }
  if (daySpan <= MAX_DATE_RANGE_DAYS) {
    return { from, to };
  }
  const endDay = new Date(`${to.slice(0, 10)}T12:00:00.000Z`);
  const minStart = new Date(
    endDay.getTime() - (MAX_DATE_RANGE_DAYS - 1) * MS_PER_DAY,
  );
  minStart.setUTCHours(0, 0, 0, 0);
  return { from: minStart.toISOString(), to };
}

export type ParsedUsageDateRange =
  | { ok: true; from?: string; to?: string }
  | { ok: false; error: string };

/**
 * Parse optional `from`/`to` query params for signed-ticket history.
 * Both must be supplied together. When `clampOversize` is true, spans longer
 * than {@link MAX_DATE_RANGE_DAYS} are shortened from the start instead of
 * rejected (Console sends epoch→now).
 */
export function parseUsageRequestDateRange(
  fromRaw: string | null | undefined,
  toRaw: string | null | undefined,
  options?: { clampOversize?: boolean },
): ParsedUsageDateRange {
  const from = fromRaw?.trim() || undefined;
  const to = toRaw?.trim() || undefined;
  if ((from && !to) || (to && !from)) {
    return { ok: false, error: "from and to must be supplied together" };
  }
  if (!from || !to) {
    return { ok: true };
  }
  if (isValidBoundedDateRange(from, to)) {
    return { ok: true, from, to };
  }
  if (options?.clampOversize) {
    const clamped = clampDateRangeToMaxDays(from, to);
    if (clamped) {
      return { ok: true, from: clamped.from, to: clamped.to };
    }
  }
  return {
    ok: false,
    error: `Invalid range; supply from <= to within ${MAX_DATE_RANGE_DAYS} days`,
  };
}

/** Decode a route/query segment; returns null when the escape sequence is invalid. */
export function tryDecodeURIComponent(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** YYYY-MM-DD keys from period bounds (inclusive of both calendar days). */
export function dateKeysInclusiveUtc(periodStartIso: string, periodEndIso: string): string[] {
  const startDay = new Date(`${periodStartIso.slice(0, 10)}T12:00:00.000Z`);
  const endDay = new Date(`${periodEndIso.slice(0, 10)}T12:00:00.000Z`);
  const keys: string[] = [];
  let t = startDay.getTime();
  const endT = endDay.getTime();
  const dayDiff = Math.floor((endT - t) / MS_PER_DAY) + 1;
  if (dayDiff > MAX_DATE_RANGE_DAYS) {
    throw new Error(`dateKeysInclusiveUtc: Range exceeds maximum of ${MAX_DATE_RANGE_DAYS} days`);
  }
  while (t <= endT) {
    const current = new Date(t);
    keys.push(current.toISOString().slice(0, 10));
    t += MS_PER_DAY;
  }
  return keys;
}
