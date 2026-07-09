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
        {sub ? (
          <span
            className="group/info relative inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-zinc-500 transition-colors hover:text-zinc-300 focus-within:text-zinc-300"
            tabIndex={0}
            aria-label={sub}
          >
            <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.75}
                d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <span
              role="tooltip"
              className="pointer-events-none absolute left-1/2 top-full z-20 mt-1.5 hidden w-max max-w-[220px] -translate-x-1/2 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-[11px] font-normal normal-case tracking-normal text-zinc-300 shadow-lg group-hover/info:block group-focus-within/info:block"
            >
              {sub}
            </span>
          </span>
        ) : null}
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
