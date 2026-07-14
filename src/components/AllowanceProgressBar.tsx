import { formatUsdMicrosDisplay } from "@/lib/format-usd-micros";

/** Progress toward a plan's included usage allowance for the billing cycle. */
export default function AllowanceProgressBar({
  usedUsdMicros,
  allowanceUsdMicros,
  className = "mt-3",
}: Readonly<{
  usedUsdMicros: string;
  /** Included cycle allowance in USD micros (backed by plan discounts.usage). */
  allowanceUsdMicros: string;
  className?: string;
}>) {
  let used: bigint;
  let allowance: bigint;
  try {
    used = BigInt(usedUsdMicros);
    allowance = BigInt(allowanceUsdMicros);
  } catch {
    return null;
  }
  if (allowance <= 0n) return null;

  const capped = used > allowance ? allowance : used;
  const pct = Number((capped * 10000n) / allowance) / 100;
  const exhausted = used >= allowance;
  const barClass = exhausted
    ? "bg-gradient-to-r from-amber-600 to-amber-400"
    : "bg-gradient-to-r from-emerald-600 to-emerald-400";

  return (
    <div className={className}>
      <div className="relative h-1.5 overflow-hidden rounded-[3px] bg-zinc-800">
        <div
          className={`absolute inset-y-0 left-0 rounded-[3px] ${barClass}`}
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
          aria-hidden
        />
      </div>
      <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2 text-[12px] text-zinc-500">
        <span className="font-mono">
          <b className="font-medium text-zinc-300">
            {formatUsdMicrosDisplay(used.toString())}
          </b>
          {" / "}
          {formatUsdMicrosDisplay(allowance.toString())} included this cycle
        </span>
        <span className="font-mono text-[11.5px] text-zinc-600">
          {pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)}% of allowance used
        </span>
      </div>
    </div>
  );
}
