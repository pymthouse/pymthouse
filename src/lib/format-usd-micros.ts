function isIntegerMicrosString(value: string): boolean {
  if (value.length === 0) return false;
  let i = 0;
  if (value.startsWith("-")) {
    if (value.length === 1) return false;
    i = 1;
  }
  for (; i < value.length; i++) {
    const code = value.codePointAt(i);
    if (code == null || code < 48 || code > 57) return false;
  }
  return true;
}

/** Drop trailing zeros from a fractional digit string (no decimal point). */
function trimFracDigitZeros(fracDigits: string): string {
  let end = fracDigits.length;
  while (end > 0 && fracDigits[end - 1] === "0") end -= 1;
  return fracDigits.slice(0, end);
}

/** 1 USD = 1_000_000 micros (ledger / allowance / OpenMeter network fee meter). */
export const USD_MICROS_PER_DOLLAR = 1_000_000n;

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
  if (!isIntegerMicrosString(t)) return null;
  try {
    const negative = t.startsWith("-");
    const abs = BigInt(negative ? t.slice(1) : t);
    if (abs === 0n) return null;
    const whole = abs / USD_MICROS_PER_DOLLAR;
    const frac = abs % USD_MICROS_PER_DOLLAR;
    const digits = Math.min(6, Math.max(0, Math.floor(maxFractionDigits)));
    const fracStr = trimFracDigitZeros(
      frac.toString().padStart(6, "0").slice(0, digits),
    );
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
 * Format USD micros for starter allowance UI as fixed `$0.00` currency
 * (cents precision; truncates sub-cent remainders).
 */
export function formatUsdMicrosDisplay(microsStr: string | undefined | null): string {
  if (microsStr == null || microsStr === "") return "$0.00";
  const t = microsStr.trim();
  if (!isIntegerMicrosString(t)) return "$0.00";
  try {
    const negative = t.startsWith("-");
    const abs = BigInt(negative ? t.slice(1) : t);
    const whole = abs / USD_MICROS_PER_DOLLAR;
    const frac = abs % USD_MICROS_PER_DOLLAR;
    const cents = frac.toString().padStart(6, "0").slice(0, 2);
    return `${negative ? "-" : ""}$${whole.toString()}.${cents}`;
  } catch {
    return "$0.00";
  }
}
