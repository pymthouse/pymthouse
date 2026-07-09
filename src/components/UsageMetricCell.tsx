import InfoTooltip from "@/components/InfoTooltip";

type UsageMetricCellProps = Readonly<{
  label: string;
  value: string;
  /** Helper copy shown in a hover info tooltip next to the label. */
  sub: string;
  live?: boolean;
  title?: string;
}>;

/**
 * Compact usage metric: bright label + slightly dimmer value, with helper
 * context on an info icon hover instead of a subtitle under the number.
 */
export default function UsageMetricCell({
  label,
  value,
  sub,
  live,
  title,
}: UsageMetricCellProps) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 mb-1">
        <p className="text-[11px] font-semibold text-zinc-300 uppercase tracking-widest">
          {label}
        </p>
        {live && (
          <span className="relative flex h-1.5 w-1.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500" />
          </span>
        )}
        {sub ? <InfoTooltip label={sub} /> : null}
      </div>
      <p
        className="font-mono text-sm font-semibold text-zinc-400 tabular-nums truncate"
        title={title ?? value}
      >
        {value}
      </p>
    </div>
  );
}
