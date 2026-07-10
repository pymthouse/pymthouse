import { formatUsdMicrosDisplay } from "@/lib/format-usd";
import { defaultStarterIncludedUsdMicros } from "@/lib/starter-default-plan-display";

type AllowanceStripProps = Readonly<{
  /** Network fees consumed this billing period (USD micros). */
  consumedUsdMicros: string;
  /** Signed / metered request count this period. */
  requestCount: number;
  /** Override grant; defaults to Starter included micros. */
  grantedUsdMicros?: string;
}>;

/**
 * Starter allowance / credit-remaining strip with usage meter.
 * Mirrors the Livepeer dashboard Usage "Starter allowance" treatment.
 * Period / reset details live on the parent panel's info tooltip.
 */
export default function AllowanceStrip({
  consumedUsdMicros,
  requestCount,
  grantedUsdMicros,
}: AllowanceStripProps) {
  const grantedRaw = grantedUsdMicros ?? defaultStarterIncludedUsdMicros();
  const granted = BigInt(grantedRaw || "0");
  if (granted <= 0n) {
    return null;
  }

  let consumed = 0n;
  try {
    consumed = BigInt(consumedUsdMicros || "0");
  } catch {
    consumed = 0n;
  }
  if (consumed < 0n) consumed = 0n;

  const remaining = consumed >= granted ? 0n : granted - consumed;
  const hasAccess = remaining > 0n;
  const usedPct = Number((consumed * 10000n) / granted) / 100;
  const pct = Math.min(100, usedPct);
  const nearExhausted = pct >= 90;

  let barClass = "bg-gradient-to-r from-emerald-600 to-emerald-400";
  if (!hasAccess) {
    barClass = "bg-amber-500";
  } else if (nearExhausted) {
    barClass = "bg-gradient-to-r from-amber-600 to-amber-400";
  }

  return (
    <div className="mb-5 flex flex-col gap-3 rounded-lg border border-white/[0.06] bg-black/20 px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-mono text-[10.5px] font-medium uppercase tracking-[0.06em] text-zinc-500">
          Starter allowance
        </p>
        {!hasAccess && (
          <span className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-amber-400">
            Exhausted
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-baseline gap-3">
        <span className="font-mono text-[15px] tabular-nums leading-none text-zinc-400">
          <b className="mr-0.5 text-[22px] font-medium tracking-[-0.01em] text-zinc-100">
            {formatUsdMicrosDisplay(remaining.toString())}
          </b>
          <span className="text-zinc-500">
            {" "}
            / {formatUsdMicrosDisplay(granted.toString())} remaining
          </span>
        </span>
      </div>

      <div className="relative h-1.5 overflow-hidden rounded-[3px] bg-zinc-800">
        <meter
          className="absolute inset-0 h-full w-full opacity-0"
          min={0}
          max={100}
          value={pct}
          aria-label="Starter allowance used"
        />
        <div
          className={`pointer-events-none absolute inset-y-0 left-0 rounded-[3px] ${barClass}`}
          style={{ width: `${pct}%` }}
          aria-hidden
        />
      </div>

      <div className="flex flex-wrap items-baseline justify-between gap-4 text-[12px] text-zinc-500">
        <span className="font-mono">
          <b className="font-medium text-zinc-300">{requestCount.toLocaleString()}</b> signed
          requests this period
          {" · "}
          <b className="font-medium text-zinc-300">
            {formatUsdMicrosDisplay(consumed.toString())}
          </b>{" "}
          consumed
        </span>
        <span className="font-mono text-[11.5px] text-zinc-600">
          {pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)}% used
        </span>
      </div>
    </div>
  );
}
