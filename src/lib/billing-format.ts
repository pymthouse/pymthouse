/** Client-safe billing display helpers (no Node/DB imports). */

export function formatBillingWei(wei: string): string {
  if (!wei || !/^\d+$/.test(wei)) return "0";
  const value = BigInt(wei);
  if (value === 0n) return "0";
  const divisor = 10n ** 18n;
  const whole = value / divisor;
  const remainder = value % divisor;
  if (whole === 0n && remainder > 0n) return `${value.toString()} wei`;
  const fracStr = remainder.toString().padStart(18, "0").slice(0, 6);
  return `${whole}.${fracStr} ETH`;
}

export function formatBillingPeriod(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

/**
 * Compact duration from a `billable_secs` meter total (e.g. `4m 12s`, `1h 03m`).
 * Sub-second totals render as `<1s` so metered work never displays as zero.
 */
export function formatBillableDuration(billableSecs: string | null | undefined): string {
  if (billableSecs == null || billableSecs === "") return "—";
  const secs = Number(billableSecs);
  if (!Number.isFinite(secs) || secs < 0) return "—";
  if (secs === 0) return "—";
  if (secs < 1) return "<1s";

  const total = Math.floor(secs);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  if (hours > 0) {
    return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

/** Short label for when the current billing period resets (e.g. "Jul 31"). */
export function formatPeriodResetLabel(periodEndIso: string): string {
  try {
    const end = new Date(periodEndIso);
    if (Number.isNaN(end.getTime())) return "next period";
    return end.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "next period";
  }
}
