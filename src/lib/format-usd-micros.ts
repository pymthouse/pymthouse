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

/**
 * Always returns a `$…` string (including `$0`) for allowance / meter UI.
 * Adaptive fraction digits match the Livepeer dashboard usage strip.
 */
export function formatUsdMicrosDisplay(microsStr: string | undefined | null): string {
  if (microsStr == null || microsStr === "" || !/^-?\d+$/.test(microsStr.trim())) {
    return "$0";
  }
  try {
    const t = microsStr.trim();
    const negative = t.startsWith("-");
    const abs = BigInt(negative ? t.slice(1) : t);
    const usd = Number(abs) / 1_000_000;
    let digits = 4;
    if (usd >= 1) digits = 2;
    else if (usd >= 0.01) digits = 3;
    // Strip trailing zeros, then a dangling decimal — avoid `\.?0+$` backtracking.
    const formatted = usd.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
    return `${negative ? "-" : ""}$${formatted === "" ? "0" : formatted}`;
  } catch {
    return "$0";
  }
}
