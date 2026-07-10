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

/** Drop trailing fractional zeros from a `Number#toFixed` string. */
function trimFixedDecimalZeros(value: string): string {
  const dot = value.indexOf(".");
  if (dot === -1) return value;
  let end = value.length;
  while (end > dot + 1 && value[end - 1] === "0") end -= 1;
  if (end === dot + 1) end = dot;
  return value.slice(0, end);
}

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
    const whole = abs / 1_000_000n;
    const frac = abs % 1_000_000n;
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
 * Always returns a `$…` string (including `$0`) for allowance / meter UI.
 * Adaptive fraction digits match the Livepeer dashboard usage strip, with up
 * to 6 places so sub-cent staging fees (e.g. 33 micros) are visible.
 */
export function formatUsdMicrosDisplay(microsStr: string | undefined | null): string {
  if (microsStr == null || microsStr === "") return "$0";
  const t = microsStr.trim();
  if (!isIntegerMicrosString(t)) return "$0";
  try {
    const negative = t.startsWith("-");
    const abs = BigInt(negative ? t.slice(1) : t);
    if (abs === 0n) return "$0";
    const usd = Number(abs) / 1_000_000;
    let digits = 6;
    if (usd >= 1) digits = 2;
    else if (usd >= 0.01) digits = 3;
    else if (usd >= 0.0001) digits = 4;
    const formatted = trimFixedDecimalZeros(usd.toFixed(digits));
    return `${negative ? "-" : ""}$${formatted === "" ? "0" : formatted}`;
  } catch {
    return "$0";
  }
}
