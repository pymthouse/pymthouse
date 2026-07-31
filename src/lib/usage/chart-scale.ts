/**
 * Pure scale/bucketing helpers for the usage chart.
 *
 * Client-safe (no DB/Node imports) and dependency-free so the tick and
 * bucketing maths can be unit tested without rendering.
 */

/** Chart metric. Rendered as separate views — never as a second y-axis. */
export type UsageChartMetric = "requests" | "cost";

/** Time bucket for the x-axis. */
export type UsageChartBucket = "day" | "week";

/** Multipliers that read as "round" on an axis (…10, 20, 25, 50, 100…). */
const NICE_MULTIPLIERS = [1, 2, 2.5, 5, 10];

/**
 * Round a rough step up to the nearest 1/2/2.5/5/10 × 10^n.
 * Without this the axis lands on values like 29/58/87/116.
 */
export function niceStep(rough: number): number {
  if (!Number.isFinite(rough) || rough <= 0) return 1;
  const exponent = Math.floor(Math.log10(rough));
  const magnitude = 10 ** exponent;
  const normalized = rough / magnitude;
  const multiplier =
    NICE_MULTIPLIERS.find((candidate) => normalized <= candidate) ?? 10;
  return multiplier * magnitude;
}

/**
 * Axis ticks from 0 to a rounded top covering `maxValue`.
 * `integerOnly` keeps request counts whole (no "2.5 requests" tick).
 */
export function buildNiceTicks(
  maxValue: number,
  options?: { tickCount?: number; integerOnly?: boolean },
): number[] {
  const tickCount = options?.tickCount ?? 4;
  if (!Number.isFinite(maxValue) || maxValue <= 0) {
    return Array.from({ length: tickCount + 1 }, (_, i) => i);
  }

  let step = niceStep(maxValue / tickCount);
  if (options?.integerOnly && step < 1) {
    step = 1;
  }
  if (options?.integerOnly && !Number.isInteger(step)) {
    step = Math.ceil(step);
  }

  const top = Math.ceil(maxValue / step) * step;
  const ticks: number[] = [];
  // Guard against float drift accumulating across additions.
  for (let i = 0; i * step <= top + step / 1000; i += 1) {
    ticks.push(Number((i * step).toPrecision(12)));
  }
  return ticks;
}

export type ChartPoint = {
  date: string;
  /** Request count for the point. */
  value: number;
  /** Network fee for the point, in USD micros. */
  feeUsdMicros?: string;
};

export type BucketedPoint = {
  /** Bucket start date key (YYYY-MM-DD). */
  date: string;
  /** Last date covered by the bucket, for labelling ranges. */
  endDate: string;
  value: number;
  feeUsdMicros: string;
};

function parseMicros(raw: string | undefined): bigint {
  if (!raw) return 0n;
  try {
    return BigInt(raw);
  } catch {
    return 0n;
  }
}

/**
 * Group daily points into fixed 7-day buckets anchored at the first date.
 *
 * Anchoring at the series start (rather than ISO weeks) keeps every series in
 * a chart aligned to the same boundaries and avoids a stub first bucket.
 */
export function bucketPoints(
  points: ChartPoint[],
  bucket: UsageChartBucket,
): BucketedPoint[] {
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  if (bucket === "day" || sorted.length === 0) {
    return sorted.map((point) => ({
      date: point.date,
      endDate: point.date,
      value: point.value,
      feeUsdMicros: parseMicros(point.feeUsdMicros).toString(),
    }));
  }

  const buckets: BucketedPoint[] = [];
  for (let i = 0; i < sorted.length; i += 7) {
    const slice = sorted.slice(i, i + 7);
    let value = 0;
    let fee = 0n;
    for (const point of slice) {
      value += point.value;
      fee += parseMicros(point.feeUsdMicros);
    }
    buckets.push({
      date: slice[0].date,
      endDate: slice[slice.length - 1].date,
      value,
      feeUsdMicros: fee.toString(),
    });
  }
  return buckets;
}

/** Plotted magnitude for a bucket under the selected metric (dollars for cost). */
export function pointMagnitude(
  point: BucketedPoint,
  metric: UsageChartMetric,
): number {
  if (metric === "requests") return point.value;
  // Axis scale only — display money still formats from the micros string.
  return Number(parseMicros(point.feeUsdMicros)) / 1_000_000;
}

/**
 * Colour slot per series, assigned once from the **unfiltered** series list.
 *
 * Colour follows the entity, not its rank: filtering the chart down to a subset
 * looks up the same slots, so surviving series keep their colour. Assigning by
 * position would repaint them; hashing would risk two visible series colliding
 * on one slot.
 */
export function buildSeriesColorMap(
  allSeriesKeys: string[],
  paletteSize: number,
): Map<string, number> {
  const map = new Map<string, number>();
  let slot = 0;
  for (const key of allSeriesKeys) {
    if (map.has(key)) continue;
    map.set(key, slot % paletteSize);
    slot += 1;
  }
  return map;
}
