"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { DashboardUsageChartSeries } from "@/lib/dashboard-usage-summary";

const SERIES_COLORS = [
  "rgb(52 211 153)", // emerald
  "rgb(96 165 250)", // blue
  "rgb(251 191 36)", // amber
  "rgb(167 139 250)", // purple
  "rgb(244 114 182)", // pink
  "rgb(45 212 191)", // teal
  "rgb(251 146 60)", // orange
  "rgb(129 140 248)", // indigo
];

type UsageBreakdownChartProps = Readonly<{
  series: DashboardUsageChartSeries[];
  /** Cap how many series are drawn; remaining are dropped (already sorted by volume). */
  maxSeries?: number;
  valueLabel?: string;
  className?: string;
  height?: number;
}>;

function utcTodayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatDayTooltipTitle(dayKey: string, todayKey: string): string {
  if (dayKey === todayKey) return "Today";
  const d = new Date(`${dayKey}T12:00:00.000Z`);
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function formatXTick(dayKey: string, todayKey: string): string {
  if (dayKey === todayKey) return "Today";
  return dayKey.slice(5);
}

function buildYTicks(maxValue: number, tickCount = 4): number[] {
  if (!Number.isFinite(maxValue) || maxValue <= 0) {
    return Array.from({ length: tickCount + 1 }, (_, i) => i);
  }
  const padded = Math.ceil(maxValue * 1.1);
  const step = Math.max(1, Math.ceil(padded / tickCount));
  const top = Math.ceil(padded / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  return ticks;
}

function seriesLabel(s: DashboardUsageChartSeries): string {
  return `${s.appName} · ${s.jobType}`;
}

/**
 * Multi-series daily usage chart. Each series is one app × job-type (pipeline)
 * pair — the two primary visual separators for admin usage.
 */
export default function UsageBreakdownChart({
  series,
  maxSeries = 8,
  valueLabel = "Requests / day",
  className = "",
  height = 160,
}: UsageBreakdownChartProps) {
  const visible = useMemo(() => series.slice(0, maxSeries), [series, maxSeries]);
  const dates = useMemo(() => visible[0]?.points.map((p) => p.date) ?? [], [visible]);
  const n = dates.length;
  const todayKey = utcTodayKey();

  const width = 720;
  const padLeft = 44;
  const padRight = 12;
  const padTop = 12;
  const padBottom = 26;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const dailyTotals = useMemo(
    () =>
      dates.map((_, i) =>
        visible.reduce((sum, s) => sum + (s.points[i]?.value ?? 0), 0),
      ),
    [dates, visible],
  );
  const maxValue = Math.max(0, ...dailyTotals);
  const yTicks = useMemo(() => buildYTicks(maxValue), [maxValue]);
  const yMax = Math.max(1, yTicks.at(-1) ?? 1);

  const xAt = useCallback(
    (i: number) => (n <= 1 ? padLeft + plotW / 2 : padLeft + (i / (n - 1)) * plotW),
    [n, plotW],
  );
  const yAt = useCallback(
    (v: number) => padTop + plotH - (v / yMax) * plotH,
    [yMax, plotH],
  );

  const linePaths = useMemo(
    () =>
      visible.map((s) =>
        s.points
          .map((p, i) => `${i === 0 ? "M" : "L"}${xAt(i)},${yAt(p.value)}`)
          .join(" "),
      ),
    [visible, xAt, yAt],
  );

  const xLabelTicks = useMemo(
    () =>
      [0, Math.floor(n / 4), Math.floor(n / 2), Math.floor((n * 3) / 4), n - 1].filter(
        (i, idx, arr) => i >= 0 && (idx === 0 || i !== arr[idx - 1]),
      ),
    [n],
  );

  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);

  const resolveIndexFromClientX = useCallback(
    (clientX: number) => {
      const el = plotRef.current;
      if (!el || n <= 0) return null;
      const rect = el.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return n === 1 ? 0 : Math.round(ratio * (n - 1));
    },
    [n],
  );

  const appsInLegend = useMemo(() => {
    const order: string[] = [];
    const byApp = new Map<string, DashboardUsageChartSeries[]>();
    for (const s of visible) {
      if (!byApp.has(s.appId)) {
        order.push(s.appId);
        byApp.set(s.appId, []);
      }
      byApp.get(s.appId)!.push(s);
    }
    return order.map((appId) => ({
      appId,
      appName: byApp.get(appId)![0].appName,
      series: byApp.get(appId)!,
    }));
  }, [visible]);

  if (visible.length === 0 || n === 0) {
    return (
      <div
        className={`rounded-lg border border-zinc-800 bg-zinc-950/40 px-4 py-8 text-center text-sm text-zinc-500 ${className}`}
      >
        No data for this period.
      </div>
    );
  }

  let tooltipLeftPct = 50;
  if (hoverIndex !== null && n > 1) {
    tooltipLeftPct = ((xAt(hoverIndex) - padLeft) / plotW) * 100;
  } else if (hoverIndex === 0) {
    tooltipLeftPct = 0;
  }

  return (
    <div className={`min-w-0 ${className}`}>
      <div className="relative w-full select-none" style={{ height }}>
        <div
          className="pointer-events-none absolute inset-y-0 left-0 flex flex-col justify-between font-mono text-[9px] tabular-nums text-zinc-500"
          style={{ width: padLeft - 4, paddingTop: padTop, paddingBottom: padBottom }}
          aria-hidden="true"
        >
          {[...yTicks].reverse().map((tick) => (
            <span key={tick} className="text-right leading-none">
              {tick.toLocaleString("en-US")}
            </span>
          ))}
        </div>

        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="block h-full w-full text-zinc-400"
          preserveAspectRatio="none"
          role="img"
          aria-label={`${valueLabel} by app and job type`}
        >
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
          {linePaths.map((d, i) => (
            <path
              key={visible[i].appId + visible[i].jobType}
              d={d}
              fill="none"
              stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
          {hoverIndex !== null && (
            <line
              x1={xAt(hoverIndex)}
              x2={xAt(hoverIndex)}
              y1={padTop}
              y2={height - padBottom}
              stroke="rgb(161 161 170)"
              strokeWidth={1}
              strokeDasharray="4 3"
              opacity={0.85}
            />
          )}
        </svg>

        <div
          className="pointer-events-none absolute font-mono text-[9px] text-zinc-500"
          style={{ left: padLeft, right: padRight, bottom: 6, height: 14 }}
          aria-hidden="true"
        >
          {xLabelTicks.map((i) => {
            const date = dates[i];
            if (!date) return null;
            return (
              <span
                key={`${date}-${i}`}
                className="absolute"
                style={{
                  left: `${n <= 1 ? 50 : (i / (n - 1)) * 100}%`,
                  transform: "translateX(-50%)",
                  whiteSpace: "nowrap",
                }}
              >
                {formatXTick(date, todayKey)}
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
            else if (e.key === "ArrowRight" && current < n - 1) setHoverIndex(current + 1);
          }}
        >
          {hoverIndex !== null && dates[hoverIndex] && (
            <div
              className="pointer-events-none absolute z-10 min-w-[160px] max-w-[240px] rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-2 shadow-lg"
              style={{
                left: `${Math.min(92, Math.max(8, tooltipLeftPct))}%`,
                bottom: "100%",
                marginBottom: 8,
                transform: "translateX(-50%)",
              }}
              role="tooltip"
            >
              <p className="font-mono text-[10px] font-medium text-zinc-200">
                {formatDayTooltipTitle(dates[hoverIndex], todayKey)}
              </p>
              <ul className="mt-1 space-y-0.5">
                {visible.map((s, i) => {
                  const value = s.points[hoverIndex]?.value ?? 0;
                  if (value <= 0) return null;
                  return (
                    <li
                      key={s.appId + s.jobType}
                      className="flex items-center gap-1.5 font-mono text-[10px] text-zinc-400"
                    >
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }}
                      />
                      <span className="truncate">{seriesLabel(s)}</span>
                      <span className="ml-auto tabular-nums text-zinc-200">
                        {value.toLocaleString("en-US")}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      </div>

      <div className="mt-3 space-y-2">
        {appsInLegend.map((group) => (
          <div key={group.appId}>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
              {group.appName}
            </p>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
              {group.series.map((s) => {
                const colorIndex = visible.findIndex(
                  (v) => v.appId === s.appId && v.jobType === s.jobType,
                );
                return (
                  <span
                    key={s.jobType}
                    className="inline-flex items-center gap-1.5 text-[11px] text-zinc-400"
                  >
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{
                        background: SERIES_COLORS[colorIndex % SERIES_COLORS.length],
                      }}
                    />
                    {s.jobType}
                    <span className="tabular-nums text-zinc-600">
                      {s.totalRequests.toLocaleString("en-US")}
                    </span>
                  </span>
                );
              })}
            </div>
          </div>
        ))}
        {series.length > maxSeries && (
          <p className="text-[11px] text-zinc-600">
            Showing top {maxSeries} of {series.length} app × job-type series
          </p>
        )}
      </div>
    </div>
  );
}
