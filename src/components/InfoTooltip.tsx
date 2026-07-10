type InfoTooltipProps = Readonly<{
  /** Accessible label and tooltip body. */
  label: string;
  /** Wider tooltips for multi-line period/scope copy. */
  wide?: boolean;
}>;

/**
 * Compact hover/focus info icon used next to section titles and metric labels.
 */
export default function InfoTooltip({ label, wide }: InfoTooltipProps) {
  return (
    <button
      type="button"
      className="group/info relative inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-zinc-500 transition-colors hover:text-zinc-300 focus-visible:text-zinc-300 focus:outline-none"
      aria-label={label}
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
        className={`pointer-events-none absolute left-1/2 top-full z-20 mt-1.5 hidden -translate-x-1/2 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-left text-[11px] font-normal normal-case tracking-normal text-zinc-300 shadow-lg group-hover/info:block group-focus-within/info:block ${
          wide ? "w-max max-w-[280px] whitespace-pre-line" : "w-max max-w-[220px]"
        }`}
      >
        {label}
      </span>
    </button>
  );
}
