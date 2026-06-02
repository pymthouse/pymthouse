"use client";

import { useCallback, useMemo, useRef, useState } from "react";

export interface UsageLineChartPoint {
  date: string;
  value: number;
}

interface UsageLineChartProps {
  data: UsageLineChartPoint[];
  /** Label for tooltip / aria (e.g. "Requests / day") */
  valueLabel?: string;
  className?: string;
}

function utcTodayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatDayTooltipTitle(dayKey: string, todayKey: string): string {
  if (dayKey === todayKey) {
    return "Today";
  }
  const d = new Date(`${dayKey}T12:00:00.000Z`);
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function formatXTick(dayKey: string, todayKey: string): string {
  if (dayKey === todayKey) {
    return "Today";
  }
  return dayKey.slice(5);
}

function buildYTicks(maxValue: number, tickCount = 4): number[] {
  if (maxValue <= 0) {
    return [0];
  }
  const padded = Math.ceil(maxValue * 1.1);
  const step = Math.max(1, Math.ceil(padded / tickCount));
  const top = Math.ceil(padded / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top; v += step) {
    ticks.push(v);
  }
  return ticks;
}

/**
 * SVG line chart with Y-axis ticks, grid lines, and per-day hover tooltips.
 */
export default function UsageLineChart({
  data,
  valueLabel = "Requests",
  className = "",
}: UsageLineChartProps) {
  const width = 720;
  const height = 200;
  const padLeft = 44;
  const padRight = 12;
  const padTop = 12;
  const padBottom = 26;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const values = useMemo(() => data.map((d) => d.value), [data]);
  const maxValue = Math.max(0, ...values);
  const yTicks = useMemo(() => buildYTicks(maxValue), [maxValue]);
  const yMax = yTicks.at(-1) ?? 1;
  const n = data.length;
  const todayKey = utcTodayKey();

  const xAt = useCallback(
    (i: number) => (n <= 1 ? padLeft + plotW / 2 : padLeft + (i / (n - 1)) * plotW),
    [n, plotW],
  );
  const yAt = useCallback(
    (v: number) => padTop + plotH - (v / yMax) * plotH,
    [yMax, plotH],
  );

  const linePoints = useMemo(
    () => data.map((d, i) => `${xAt(i)},${yAt(d.value)}`).join(" "),
    [data, xAt, yAt],
  );

  const areaPath = useMemo(() => {
    if (n === 0) {
      return "";
    }
    const top = data.map((d, i) => `${i === 0 ? "M" : "L"}${xAt(i)},${yAt(d.value)}`).join(" ");
    const baseY = yAt(0);
    return `${top} L${xAt(n - 1)},${baseY} L${xAt(0)},${baseY} Z`;
  }, [data, n, xAt, yAt]);

  const xLabelTicks = useMemo(
    () => [0, Math.floor(n / 4), Math.floor(n / 2), Math.floor((n * 3) / 4), n - 1].filter(
      (i, idx, arr) => i >= 0 && (idx === 0 || i !== arr[idx - 1]),
    ),
    [n],
  );

  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);

  const resolveIndexFromClientX = useCallback(
    (clientX: number) => {
      const el = plotRef.current;
      if (!el || n <= 0) {
        return null;
      }
      const rect = el.getBoundingClientRect();
      const x = clientX - rect.left;
      const ratio = Math.max(0, Math.min(1, x / rect.width));
      if (n === 1) {
        return 0;
      }
      return Math.round(ratio * (n - 1));
    },
    [n],
  );

  const activeIndex = hoverIndex;

  if (data.length === 0) {
    return (
      <div
        className={`rounded-lg border border-zinc-800 bg-zinc-950/40 px-4 py-8 text-center text-sm text-zinc-500 ${className}`}
      >
        No data for this period.
      </div>
    );
  }

  let tooltipLeftPct = 50;
  if (activeIndex !== null && n > 1) {
    tooltipLeftPct = ((xAt(activeIndex) - padLeft) / plotW) * 100;
  } else if (activeIndex === 0) {
    tooltipLeftPct = 0;
  }

  const valueUnit = valueLabel.toLowerCase().includes("request") ? "requests" : "value";

  return (
    <div className={`relative w-full min-w-0 select-none ${className}`} style={{ height }}>
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
        aria-label={`${valueLabel} over billing period`}
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
        <path d={areaPath} fill="rgb(16 185 129)" fillOpacity={0.12} />
        <polyline
          fill="none"
          stroke="rgb(52 211 153)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          points={linePoints}
        />
        {data.map((d, i) => (
          <circle
            key={d.date}
            cx={xAt(i)}
            cy={yAt(d.value)}
            r={
              activeIndex === i ? 4.5 : d.value > 0 ? 3 : 2
            }
            fill="rgb(16 185 129)"
            stroke={activeIndex === i ? "rgb(24 24 27)" : "none"}
            strokeWidth={activeIndex === i ? 1.5 : 0}
            opacity={d.value > 0 || activeIndex === i ? 1 : 0.35}
          />
        ))}
        {activeIndex !== null && (
          <line
            x1={xAt(activeIndex)}
            x2={xAt(activeIndex)}
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
        style={{
          left: padLeft,
          right: padRight,
          bottom: 6,
          height: 14,
        }}
        aria-hidden="true"
      >
        {xLabelTicks.map((i) => {
          const point = data[i];
          if (!point) return null;
          return (
          <span
            key={`${point.date}-${i}`}
            className="absolute"
            style={{
              left: `${n <= 1 ? 50 : (i / (n - 1)) * 100}%`,
              transform: "translateX(-50%)",
              whiteSpace: "nowrap",
            }}
          >
            {formatXTick(point.date, todayKey)}
          </span>
          );
        })}
      </div>

      <div
        ref={plotRef}
        className="absolute"
        style={{
          left: `${(padLeft / width) * 100}%`,
          right: `${(padRight / width) * 100}%`,
          top: padTop,
          bottom: padBottom,
        }}
        onMouseLeave={() => setHoverIndex(null)}
        onMouseMove={(e) => {
          const idx = resolveIndexFromClientX(e.clientX);
          setHoverIndex(idx);
        }}
      >
        <div className="flex h-full w-full">
          {data.map((d, i) => (
            <div
              key={d.date}
              className="h-full min-w-0 flex-1"
              aria-label={`${formatDayTooltipTitle(d.date, todayKey)}: ${d.value} ${valueUnit}`}
            />
          ))}
        </div>

        {activeIndex !== null && data[activeIndex] && (
          <div
            className="pointer-events-none absolute z-10 min-w-[132px] rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-2 shadow-lg"
            style={{
              left: `${Math.min(92, Math.max(8, tooltipLeftPct))}%`,
              bottom: "100%",
              marginBottom: 8,
              transform: "translateX(-50%)",
            }}
            role="tooltip"
          >
            <p className="font-mono text-[10px] font-medium text-zinc-200">
              {formatDayTooltipTitle(data[activeIndex].date, todayKey)}
            </p>
            <p className="mt-0.5 font-mono text-[10px] tabular-nums text-zinc-400">
              <span className="font-medium text-emerald-400">
                {data[activeIndex].value.toLocaleString("en-US")}
              </span>{" "}
              {data[activeIndex].value === 1 ? valueUnit.replace(/s$/, "") : valueUnit}
            </p>
            <p className="mt-1 border-t border-zinc-800 pt-1 font-mono text-[9px] text-zinc-500">
              {valueLabel}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
