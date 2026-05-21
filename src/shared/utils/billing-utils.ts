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
const MAX_DATE_RANGE_DAYS = 365; // Safety limit for date range iteration

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
