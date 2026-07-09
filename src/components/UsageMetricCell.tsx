type UsageMetricCellProps = Readonly<{
  label: string;
  value: string;
  sub: string;
  live?: boolean;
  title?: string;
}>;

/**
 * Compact usage metric: bright field label + inset value that reads like a
 * form control, so users scan structure before numbers.
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
      <div className="flex items-center gap-1.5 mb-1.5">
        <p className="text-[11px] font-semibold text-zinc-300 uppercase tracking-widest">
          {label}
        </p>
        {live && (
          <span className="relative flex h-1.5 w-1.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500" />
          </span>
        )}
      </div>
      <p
        className="rounded-md border border-white/[0.08] bg-black/35 px-2.5 py-1.5 font-mono text-sm font-semibold text-zinc-100 tabular-nums truncate"
        title={title ?? value}
      >
        {value}
      </p>
      <p className="text-xs text-zinc-500 mt-1 truncate" title={sub}>
        {sub}
      </p>
    </div>
  );
}
