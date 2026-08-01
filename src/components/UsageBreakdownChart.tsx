"use client";

import { useCallback, useMemo, useRef, useState } from "react";

import type { DashboardUsageChartSeries } from "@/lib/dashboard-usage-summary";
import { formatUsdMicrosSummary } from "@/lib/format-usd-micros";
import {
  bucketPoints,
  buildNiceTicks,
  buildSeriesColorMap,
  pointMagnitude,
  type BucketedPoint,
  type UsageChartBucket,
  type UsageChartMetric,
} from "@/lib/usage/chart-scale";

/**
 * Categorical slots, in fixed order, stepped for a dark chart surface.
 * Validated for colour-vision deficiency against zinc-950: worst adjacent
 * pair ΔE 8.4 (protan). Do not reorder or extend without re-validating —
 * the previous ad-hoc Tailwind ramp had a teal/pink pair at ΔE 5.0, which
 * deuteranopic readers could not tell apart.
 */
const SERIES_COLORS = [
  "#3987e5", // blue
  "#d95926", // orange
  "#199e70", // aqua
  "#c98500", // yellow
  "#d55181", // magenta
  "#008300", // green
  "#9085e9", // violet
  "#e66767", // red
];

type UsageBreakdownChartProps = Readonly<{
  series: DashboardUsageChartSeries[];
  /** Cap how many series are drawn; the rest fold into "Other". */
  maxSeries?: number;
  valueLabel?: string;
  className?: string;
  height?: number;
  /** Hide the metric toggle when the caller has no cost data. */
  showMetricToggle?: boolean;
}>;

function utcTodayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatBucketTitle(
  point: BucketedPoint,
  todayKey: string,
  bucket: UsageChartBucket,
): string {
  const opts: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  };
  if (bucket === "week") {
    const start = new Date(`${point.date}T12:00:00.000Z`).toLocaleDateString(
      "en-US",
      opts,
    );
    const end = new Date(`${point.endDate}T12:00:00.000Z`).toLocaleDateString(
      "en-US",
      opts,
    );
    return start === end ? start : `${start} – ${end}`;
  }
  if (point.date === todayKey) return "Today";
  return new Date(`${point.date}T12:00:00.000Z`).toLocaleDateString("en-US", {
    weekday: "short",
    ...opts,
  });
}

function formatXTick(point: BucketedPoint, todayKey: string): string {
  if (point.date === todayKey) return "Today";
  return point.date.slice(5);
}

function formatMetricValue(
  metric: UsageChartMetric,
  point: { value: number; feeUsdMicros: string },
): string {
  return metric === "requests"
    ? point.value.toLocaleString("en-US")
    : formatUsdMicrosSummary(point.feeUsdMicros);
}

function formatAxisTick(metric: UsageChartMetric, tick: number): string {
  if (metric === "requests") return tick.toLocaleString("en-US");
  return `$${tick.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function ToggleGroup<T extends string>({
  options,
  value,
  onChange,
  label,
}: Readonly<{
  options: ReadonlyArray<{ key: T; label: string }>;
  value: T;
  onChange: (next: T) => void;
  label: string;
}>) {
  return (
    <fieldset className="m-0 inline-flex min-w-0 rounded-lg border border-solid border-zinc-700 p-0.5">
      <legend className="sr-only">{label}</legend>
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          onClick={() => onChange(option.key)}
          aria-pressed={value === option.key}
          className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
            value === option.key
              ? "bg-zinc-700 text-zinc-100"
              : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          {option.label}
        </button>
      ))}
    </fieldset>
  );
}

/**
 * Stacked-bar usage chart. Each series is one app × pipeline/model (or
 * app × identity). Bars stack so the column height reads as the day's total —
 * the previous overlapping translucent areas made totals impossible to read.
 *
 * Requests and cost are separate views selected by a toggle, never a second
 * y-axis.
 */
export default function UsageBreakdownChart({
  series,
  maxSeries = 8,
  valueLabel = "Requests",
  className = "",
  height = 200,
  showMetricToggle = true,
}: UsageBreakdownChartProps) {
  const [metric, setMetric] = useState<UsageChartMetric>("requests");
  const [bucket, setBucket] = useState<UsageChartBucket>("day");
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);

  // Colour slots come from the full series list so filtering never repaints.
  const colorMap = useMemo(
    () =>
      buildSeriesColorMap(
        series.map((s) => `${s.appId}|${s.jobType}`),
        SERIES_COLORS.length,
      ),
    [series],
  );

  const visible = useMemo(() => series.slice(0, maxSeries), [series, maxSeries]);
  const hiddenCount = Math.max(0, series.length - visible.length);

  const bucketedSeries = useMemo(
    () => visible.map((s) => bucketPoints(s.points, bucket)),
    [visible, bucket],
  );
  // Axis = union of all series dates so a sparse series cannot shift values.
  const buckets = useMemo(() => {
    const byDate = new Map<string, BucketedPoint>();
    for (const points of bucketedSeries) {
      for (const point of points) {
        if (!byDate.has(point.date)) byDate.set(point.date, point);
      }
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }, [bucketedSeries]);
  const seriesByDate = useMemo(
    () => bucketedSeries.map((points) => new Map(points.map((p) => [p.date, p]))),
    [bucketedSeries],
  );
  const n = buckets.length;
  const todayKey = utcTodayKey();

  // Stacked: the axis must cover each column's summed height.
  const columnTotals = useMemo(
    () =>
      buckets.map((bucketPoint) =>
        seriesByDate.reduce((sum, byDate) => {
          const point = byDate.get(bucketPoint.date);
          return sum + (point ? pointMagnitude(point, metric) : 0);
        }, 0),
      ),
    [buckets, seriesByDate, metric],
  );

  const yTicks = useMemo(
    () =>
      buildNiceTicks(Math.max(0, ...columnTotals), {
        tickCount: 4,
        integerOnly: metric === "requests",
      }),
    [columnTotals, metric],
  );
  const yMax = Math.max(yTicks.at(-1) ?? 1, 1);

  const width = 720;
  const padLeft = 52;
  const padRight = 12;
  const padTop = 12;
  const padBottom = 26;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const yAt = useCallback(
    (v: number) => padTop + plotH - (v / yMax) * plotH,
    [yMax, plotH],
  );

  const slotW = n > 0 ? plotW / n : plotW;
  // Thin marks with breathing room; never wider than a comfortable bar.
  const barW = Math.max(2, Math.min(28, slotW * 0.62));
  const barX = useCallback(
    (i: number) => padLeft + slotW * i + (slotW - barW) / 2,
    [slotW, barW],
  );

  const resolveIndexFromClientX = useCallback(
    (clientX: number) => {
      const el = plotRef.current;
      if (!el || n <= 0) return null;
      const rect = el.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(0.999, (clientX - rect.left) / rect.width));
      return Math.min(n - 1, Math.floor(ratio * n));
    },
    [n],
  );

  const xLabelIndices = useMemo(() => {
    if (n === 0) return [];
    const target = Math.min(n, 6);
    const stride = Math.max(1, Math.round(n / target));
    const out: number[] = [];
    for (let i = 0; i < n; i += stride) out.push(i);
    if (out.at(-1) !== n - 1) out.push(n - 1);
    return out;
  }, [n]);

  // Empty state is based on request counts, not the selected metric — a zero
  // cost view must not hide the metric toggle with no way back.
  const hasAnyValue = useMemo(
    () =>
      bucketedSeries.some((points) => points.some((point) => point.value > 0)),
    [bucketedSeries],
  );

  if (visible.length === 0 || n === 0 || !hasAnyValue) {
    return (
      <div
        className={`rounded-lg border border-zinc-800 bg-zinc-950/40 px-4 py-8 text-center ${className}`}
      >
        <p className="text-sm text-zinc-400">No usage in this period yet</p>
        <p className="mt-1 text-xs text-zinc-600">
          Requests appear here within a few minutes of your first metered call.
        </p>
      </div>
    );
  }

  const tooltipLeftPct = hoverIndex === null ? 50 : ((hoverIndex + 0.5) / n) * 100;

  return (
    <div className={`min-w-0 ${className}`}>
      <div className="mb-3 flex flex-wrap items-center justify-end gap-2">
        {showMetricToggle ? (
          <ToggleGroup
            label="Chart metric"
            value={metric}
            onChange={setMetric}
            options={[
              { key: "requests", label: "Requests" },
              { key: "cost", label: "$" },
            ]}
          />
        ) : null}
        <ToggleGroup
          label="Time bucket"
          value={bucket}
          onChange={setBucket}
          options={[
            { key: "day", label: "Daily" },
            { key: "week", label: "Weekly" },
          ]}
        />
      </div>

      <div className="relative w-full select-none" style={{ height }}>
        <div
          className="pointer-events-none absolute inset-y-0 left-0 flex flex-col justify-between font-mono text-[9px] tabular-nums text-zinc-500"
          style={{ width: padLeft - 6, paddingTop: padTop, paddingBottom: padBottom }}
          aria-hidden="true"
        >
          {[...yTicks].reverse().map((tick) => (
            <span key={tick} className="text-right leading-none">
              {formatAxisTick(metric, tick)}
            </span>
          ))}
        </div>

        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="block h-full w-full"
          preserveAspectRatio="none"
          aria-label={`${valueLabel} by series`}
        >
          <title>{`${valueLabel} by series`}</title>
          {yTicks.map((tick) => (
            <line
              key={tick}
              x1={padLeft}
              x2={width - padRight}
              y1={yAt(tick)}
              y2={yAt(tick)}
              stroke="rgb(39 39 42)"
              strokeDasharray={tick === 0 ? undefined : "3 4"}
              strokeOpacity={tick === 0 ? 1 : 0.75}
            />
          ))}

          {Array.from({ length: n }, (_, i) => {
            let cursor = 0;
            const bucketDate = buckets[i].date;
            return (
              <g key={bucketDate} opacity={hoverIndex === null || hoverIndex === i ? 1 : 0.45}>
                {seriesByDate.map((byDate, sIdx) => {
                  const point = byDate.get(bucketDate);
                  if (!point) return null;
                  const magnitude = pointMagnitude(point, metric);
                  if (magnitude <= 0) return null;
                  const yTop = yAt(cursor + magnitude);
                  const yBottom = yAt(cursor);
                  cursor += magnitude;
                  // 2px surface gap between stacked segments.
                  const segH = Math.max(1, yBottom - yTop - 2);
                  const s = visible[sIdx];
                  const color =
                    SERIES_COLORS[colorMap.get(`${s.appId}|${s.jobType}`) ?? sIdx];
                  return (
                    <rect
                      key={`${s.appId}|${s.jobType}`}
                      x={barX(i)}
                      y={yTop}
                      width={barW}
                      height={segH}
                      rx={2}
                      fill={color}
                    />
                  );
                })}
              </g>
            );
          })}
        </svg>

        <div
          className="pointer-events-none absolute font-mono text-[9px] text-zinc-500"
          style={{ left: padLeft, right: padRight, bottom: 6, height: 14 }}
          aria-hidden="true"
        >
          {xLabelIndices.map((i) => {
            const point = buckets[i];
            if (!point) return null;
            return (
              <span
                key={point.date}
                className="absolute whitespace-nowrap"
                style={{
                  left: `${((i + 0.5) / n) * 100}%`,
                  transform: "translateX(-50%)",
                }}
              >
                {formatXTick(point, todayKey)}
              </span>
            );
          })}
        </div>

        <div
          ref={plotRef}
          role="slider"
          tabIndex={0}
          aria-label={valueLabel}
          aria-valuemin={0}
          aria-valuemax={Math.max(0, n - 1)}
          aria-valuenow={hoverIndex ?? 0}
          className="absolute"
          style={{
            left: `${(padLeft / width) * 100}%`,
            right: `${(padRight / width) * 100}%`,
            top: padTop,
            bottom: padBottom,
          }}
          onMouseLeave={() => setHoverIndex(null)}
          onMouseMove={(e) => setHoverIndex(resolveIndexFromClientX(e.clientX))}
          onKeyDown={(e) => {
            const current = hoverIndex ?? 0;
            if (e.key === "ArrowLeft" && current > 0) setHoverIndex(current - 1);
            else if (e.key === "ArrowRight" && current < n - 1) {
              setHoverIndex(current + 1);
            }
          }}
        >
          {hoverIndex !== null && buckets[hoverIndex] ? (
            <div
              className="pointer-events-none absolute z-10 min-w-[180px] max-w-[260px] rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-2 shadow-lg"
              style={{
                left: `${Math.min(90, Math.max(10, tooltipLeftPct))}%`,
                bottom: "100%",
                marginBottom: 8,
                transform: "translateX(-50%)",
              }}
              role="tooltip"
            >
              <p className="font-mono text-[10px] font-medium text-zinc-200">
                {formatBucketTitle(buckets[hoverIndex], todayKey, bucket)}
              </p>
              <ul className="mt-1 space-y-0.5">
                {seriesByDate.map((byDate, sIdx) => {
                  const point = byDate.get(buckets[hoverIndex].date);
                  if (!point || pointMagnitude(point, metric) <= 0) return null;
                  const s = visible[sIdx];
                  const color =
                    SERIES_COLORS[colorMap.get(`${s.appId}|${s.jobType}`) ?? sIdx];
                  return (
                    <li
                      key={`${s.appId}|${s.jobType}`}
                      className="flex items-center gap-1.5 font-mono text-[10px] text-zinc-400"
                    >
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ background: color }}
                      />
                      <span className="truncate">
                        {s.appName} · {s.jobType}
                      </span>
                      <span className="ml-auto tabular-nums text-zinc-200">
                        {formatMetricValue(metric, point)}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <div className="mt-1.5 flex items-center gap-2 border-t border-zinc-800 pt-1.5 font-mono text-[10px]">
                <span className="text-zinc-400">Total</span>
                <span className="ml-auto tabular-nums text-zinc-100">
                  {metric === "requests"
                    ? columnTotals[hoverIndex].toLocaleString("en-US")
                    : formatUsdMicrosSummary(
                        seriesByDate
                          .reduce((sum, byDate) => {
                            const point = byDate.get(buckets[hoverIndex].date);
                            return sum + BigInt(point?.feeUsdMicros ?? "0");
                          }, 0n)
                          .toString(),
                      )}
                </span>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <ul className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map((s) => {
          const color = SERIES_COLORS[colorMap.get(`${s.appId}|${s.jobType}`) ?? 0];
          return (
            <li
              key={`${s.appId}|${s.jobType}`}
              className="flex min-w-0 items-center gap-1.5 text-[11px] text-zinc-400"
            >
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: color }}
              />
              <span className="truncate" title={`${s.appName} · ${s.jobType}`}>
                <span className="text-zinc-500">{s.appName}</span> · {s.jobType}
              </span>
              <span className="ml-auto shrink-0 tabular-nums text-zinc-600">
                {metric === "requests"
                  ? s.totalRequests.toLocaleString("en-US")
                  : formatUsdMicrosSummary(s.totalFeeUsdMicros ?? "0")}
              </span>
            </li>
          );
        })}
      </ul>
      {hiddenCount > 0 ? (
        <p className="mt-2 text-[11px] text-zinc-600">
          Showing top {maxSeries} of {series.length} series · {hiddenCount} not shown
        </p>
      ) : null}
    </div>
  );
}
