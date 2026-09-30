/**
 * Format integer USD micros strings (1 USD = 1_000_000 micros) without Number precision loss.
 * Returns null for missing, invalid, or zero values.
 */
export function formatUsdMicrosString(
  microsStr: string | undefined | null,
  maxFractionDigits: number,
): string | null {
  if (microsStr == null || microsStr === "") return null;
  const t = microsStr.trim();
  if (!/^-?\d+$/.test(t)) return null;
  try {
    const negative = t.startsWith("-");
    const abs = BigInt(negative ? t.slice(1) : t);
    if (abs === 0n) return null;
    const whole = abs / 1_000_000n;
    const frac = abs % 1_000_000n;
    const digits = Math.min(6, Math.max(0, Math.floor(maxFractionDigits)));
    let fracStr = frac.toString().padStart(6, "0").slice(0, digits);
    fracStr = fracStr.replace(/0+$/, "");
    const sign = negative ? "-" : "";
    if (fracStr.length === 0) {
      return `${sign}$${whole.toString()}`;
    }
    return `${sign}$${whole.toString()}.${fracStr}`;
  } catch {
    return null;
  }
}
