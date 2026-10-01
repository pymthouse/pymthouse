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

/** Query/path key for a UTC billing month (`YYYY-MM`). */
export const BILLING_CYCLE_PARAM = "cycle";

/** How many past months the cycle picker lists, including the current month. */
export const BILLING_CYCLE_LOOKBACK_MONTHS = 12;

const YEAR_MONTH_RE = /^(\d{4})-(\d{2})$/;

export type BillingCycleSelection = {
  /** UTC year-month, e.g. `2026-07`. */
  key: string;
  start: string;
  end: string;
  isCurrent: boolean;
};

/** UTC `YYYY-MM` for `date`. */
export function utcYearMonthKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/** Calendar-month UTC bounds for a `YYYY-MM` key, or null when malformed. */
export function calendarMonthBoundsForYearMonth(
  yearMonth: string,
): { start: string; end: string } | null {
  const match = YEAR_MONTH_RE.exec(yearMonth.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return calendarMonthBoundsUtc(new Date(Date.UTC(year, month - 1, 15)));
}

/**
 * Resolve a `cycle=YYYY-MM` query value to UTC month bounds.
 * Missing, future, or malformed keys fall back to the current UTC month.
 */
export function resolveBillingCycle(
  raw: string | null | undefined,
  now: Date = new Date(),
): BillingCycleSelection {
  const currentKey = utcYearMonthKey(now);
  const current = calendarMonthBoundsUtc(now);
  const requested = raw?.trim() ?? "";
  if (!requested) {
    return {
      key: currentKey,
      start: current.start,
      end: current.end,
      isCurrent: true,
    };
  }
  const bounds = calendarMonthBoundsForYearMonth(requested);
  if (!bounds || requested > currentKey) {
    return {
      key: currentKey,
      start: current.start,
      end: current.end,
      isCurrent: true,
    };
  }
  return {
    key: requested,
    start: bounds.start,
    end: bounds.end,
    isCurrent: requested === currentKey,
  };
}

/** Recent UTC months newest-first, including the current month. */
export function listRecentBillingCycleKeys(
  now: Date = new Date(),
  count: number = BILLING_CYCLE_LOOKBACK_MONTHS,
): string[] {
  const size = Number.isFinite(count) && count > 0 ? Math.floor(count) : BILLING_CYCLE_LOOKBACK_MONTHS;
  const year = now.getUTCFullYear();
  const monthIndex = now.getUTCMonth();
  const keys: string[] = [];
  for (let offset = 0; offset < size; offset += 1) {
    keys.push(utcYearMonthKey(new Date(Date.UTC(year, monthIndex - offset, 1))));
  }
  return keys;
}

/**
 * Lookback months from `earliestKey` through the current month.
 * Missing or malformed keys keep the full lookback.
 */
export function listBillingCycleKeysSince(
  earliestKey: string | null | undefined,
  now: Date = new Date(),
  count: number = BILLING_CYCLE_LOOKBACK_MONTHS,
): string[] {
  const recent = listRecentBillingCycleKeys(now, count);
  const earliest = earliestKey?.trim() ?? "";
  if (!calendarMonthBoundsForYearMonth(earliest)) {
    return recent;
  }
  const filtered = recent.filter((key) => key >= earliest);
  return filtered.length > 0 ? filtered : recent;
}

/** Path plus `?cycle=` when `cycleStart` is not the current UTC month. */
export function billingCycleHref(
  path: string,
  cycleStart: string,
  now: Date = new Date(),
): string {
  const selected = resolveBillingCycle(cycleStart.slice(0, 7), now);
  if (selected.isCurrent) return path;
  const joiner = path.includes("?") ? "&" : "?";
  return `${path}${joiner}${BILLING_CYCLE_PARAM}=${selected.key}`;
}

/** `2026-07` → `July 2026`. */
export function formatBillingCycleMonthLabel(yearMonth: string): string {
  const bounds = calendarMonthBoundsForYearMonth(yearMonth);
  if (!bounds) return yearMonth;
  return new Date(bounds.start).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export type BillingCycleOption = {
  key: string;
  label: string;
  isCurrent: boolean;
};

/** Picker options: recent months plus a bookmarked key that fell off the list. */
export function billingCycleSelectOptions(input: {
  selectedKey: string;
  now?: Date;
  count?: number;
  /** First UTC month with usage. Earlier lookback months are omitted. */
  earliestKey?: string | null;
}): BillingCycleOption[] {
  const now = input.now ?? new Date();
  const currentKey = utcYearMonthKey(now);
  const keys = listBillingCycleKeysSince(input.earliestKey, now, input.count);
  const selected = input.selectedKey.trim();
  if (selected && !keys.includes(selected) && calendarMonthBoundsForYearMonth(selected)) {
    keys.push(selected);
    keys.sort((a, b) => b.localeCompare(a));
  }
  return keys.map((key) => ({
    key,
    label: formatBillingCycleMonthLabel(key),
    isCurrent: key === currentKey,
  }));
}

/**
 * True when an invoice's billing period (or issued-at fallback) overlaps the
 * cycle. Used to highlight a month on Billing / identity payment history.
 */
export function invoiceOverlapsCycle(
  invoice: {
    issuedAt?: string | null;
    periodStart?: string | null;
    periodEnd?: string | null;
  },
  cycle: { start: string; end: string },
): boolean {
  const cycleStart = Date.parse(cycle.start);
  const cycleEnd = Date.parse(cycle.end);
  if (Number.isNaN(cycleStart) || Number.isNaN(cycleEnd)) return false;

  const periodStart = invoice.periodStart ? Date.parse(invoice.periodStart) : Number.NaN;
  const periodEnd = invoice.periodEnd ? Date.parse(invoice.periodEnd) : Number.NaN;
  if (!Number.isNaN(periodStart) && !Number.isNaN(periodEnd)) {
    return periodStart <= cycleEnd && periodEnd >= cycleStart;
  }
  const issued = invoice.issuedAt ? Date.parse(invoice.issuedAt) : Number.NaN;
  if (Number.isNaN(issued)) return false;
  return issued >= cycleStart && issued <= cycleEnd;
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
