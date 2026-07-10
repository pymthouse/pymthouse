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
