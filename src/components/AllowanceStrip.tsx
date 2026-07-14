import {
  formatUsdMicrosDisplay,
  hasPositiveUsdMicrosBalance,
} from "@/lib/format-usd-micros";

type AllowanceStripProps = Readonly<{
  /** Live prepaid credit remaining (USD micros) — same ledger as the mint/balance gates. */
  balanceUsdMicros: string;
  /** Lifetime prepaid grants (USD micros). */
  lifetimeGrantedUsdMicros: string;
  /** Lifetime grants minus live balance (USD micros). */
  consumedUsdMicros: string;
  /** Signed / metered request count this period (usage context only). */
  requestCount: number;
  /**
   * Clarifies Konnect customer scope (credits are per end-user customer;
   * UI may sum many wallets).
   */
  scopeHint?: string;
}>;

/**
 * Prepaid credit strip backed by the live Konnect/OpenMeter credit ledger
 * (not period network fees vs a fixed $5 Starter estimate).
 */
export default function AllowanceStrip({
  balanceUsdMicros,
  lifetimeGrantedUsdMicros,
  consumedUsdMicros,
  requestCount,
  scopeHint,
}: AllowanceStripProps) {
  const granted = parseNonNegativeMicros(lifetimeGrantedUsdMicros);
  const remaining = parseNonNegativeMicros(balanceUsdMicros);
  const consumed = parseNonNegativeMicros(consumedUsdMicros);
  if (granted == null || remaining == null || consumed == null) {
    return null;
  }

  // Nothing to show until at least one grant exists (or residual live balance).
  if (granted <= 0n && remaining <= 0n) {
    return null;
  }

  const hasAccess = hasPositiveUsdMicrosBalance(remaining.toString());
  const denom = granted > 0n ? granted : remaining + consumed;
  let usedPct = 0;
  if (denom > 0n) {
    usedPct = Number((consumed * 10000n) / denom) / 100;
  }
  const pct = Math.min(100, Math.max(0, usedPct));
  const nearExhausted = hasAccess && pct >= 90;

  let barClass = "bg-gradient-to-r from-emerald-600 to-emerald-400";
  if (!hasAccess) {
    barClass = "bg-amber-500";
  } else if (nearExhausted) {
    barClass = "bg-gradient-to-r from-amber-600 to-amber-400";
  }

  const grantedDisplay = granted > 0n ? granted : remaining;

  return (
    <div className="mb-5 flex flex-col gap-3 rounded-lg border border-white/[0.06] bg-black/20 px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-mono text-[10.5px] font-medium uppercase tracking-[0.06em] text-zinc-500">
          Prepaid credits
        </p>
        {!hasAccess && (
          <span className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-amber-400">
            Exhausted
          </span>
        )}
      </div>

      {scopeHint ? (
        <p className="text-[11px] leading-snug text-zinc-600">{scopeHint}</p>
      ) : null}

      <div className="flex flex-wrap items-baseline gap-3">
        <span className="font-mono text-[15px] tabular-nums leading-none text-zinc-400">
          <b className="mr-0.5 text-[22px] font-medium tracking-[-0.01em] text-zinc-100">
            {formatUsdMicrosDisplay(remaining.toString())}
          </b>
          <span className="text-zinc-500">
            {" "}
            / {formatUsdMicrosDisplay(grantedDisplay.toString())} remaining
          </span>
        </span>
      </div>

      <div className="relative h-1.5 overflow-hidden rounded-[3px] bg-zinc-800">
        <meter
          className="absolute inset-0 h-full w-full opacity-0"
          min={0}
          max={100}
          value={pct}
          aria-label="Prepaid credits used"
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
          credits consumed
        </span>
        <span className="font-mono text-[11.5px] text-zinc-600">
          {pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)}% used
        </span>
      </div>
    </div>
  );
}

function parseNonNegativeMicros(raw: string): bigint | null {
  try {
    const value = BigInt(raw || "0");
    return value < 0n ? 0n : value;
  } catch {
    return null;
  }
}
