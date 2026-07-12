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

/** Smallest USD amount the usage UI prints exactly ($0.0001 = 100 micros). */
export const USD_MICROS_DISPLAY_FLOOR = 100n;

/**
 * Parse an integer USD micros string. Returns null for missing/invalid input.
 * Used by the mint allowance gate so access matches billed micros exactly.
 */
export function parseUsdMicrosString(raw: string | null | undefined): bigint | null {
  if (raw == null) return null;
  const t = raw.trim();
  if (!isIntegerMicrosString(t)) return null;
  try {
    return BigInt(t);
  } catch {
    return null;
  }
}

/** True when remaining starter/trial credit is at least 1 USD micro. */
export function hasPositiveUsdMicrosBalance(
  balanceUsdMicros: string | null | undefined,
): boolean {
  const amount = parseUsdMicrosString(balanceUsdMicros);
  return amount != null && amount > 0n;
}

/**
 * Format integer USD micros strings (1 USD = 1_000_000 micros) without Number precision loss.
 * Returns null for missing, invalid, or zero values.
 * Positive amounts below $0.0001 (100 micros) render as `< $0.0001` so usage never looks free.
 * Amounts at or above the floor always use full micro precision (6 fraction digits).
 *
 * @param _maxFractionDigits Kept for call-site compatibility; display precision is fixed at 6.
 */
export function formatUsdMicrosString(
  microsStr: string | undefined | null,
  _maxFractionDigits: number = 6,
): string | null {
  if (microsStr == null || microsStr === "") return null;
  const amount = parseUsdMicrosString(microsStr);
  if (amount == null) return null;
  try {
    const negative = amount < 0n;
    const abs = negative ? -amount : amount;
    if (abs === 0n) return null;
    if (abs < USD_MICROS_DISPLAY_FLOOR) {
      return negative ? "> -$0.0001" : "< $0.0001";
    }
    const whole = abs / USD_MICROS_PER_DOLLAR;
    const frac = abs % USD_MICROS_PER_DOLLAR;
    const fracStr = trimFracDigitZeros(frac.toString().padStart(6, "0"));
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

/**
 * Convert USD micros to a dollar amount string for inputs (no `$`).
 * Up to 6 fractional digits (micro precision); trailing zeros trimmed.
 */
export function usdMicrosToDollarAmount(
  microsStr: string | null | undefined,
): string {
  const amount = parseUsdMicrosString(microsStr);
  if (amount == null || amount < 0n) return "";
  const whole = amount / USD_MICROS_PER_DOLLAR;
  const frac = amount % USD_MICROS_PER_DOLLAR;
  if (frac === 0n) {
    return whole.toString();
  }
  const fracStr = trimFracDigitZeros(frac.toString().padStart(6, "0"));
  return `${whole.toString()}.${fracStr}`;
}

/**
 * Format USD micros as a dollar string with `$` prefix (micro precision).
 * Zero → `$0`; invalid → empty string.
 */
export function formatUsdMicrosAsDollars(
  microsStr: string | null | undefined,
): string {
  const amount = usdMicrosToDollarAmount(microsStr);
  if (amount === "") return "";
  return `$${amount}`;
}

/**
 * Parse a dollar amount input (optional leading `$`, commas ignored) into
 * integer USD micros. Supports up to 6 fractional digits; extra digits are
 * truncated toward zero. Returns null for empty/invalid/negative values.
 */
export function dollarAmountToUsdMicros(raw: string): string | null {
  const cleaned = raw.trim().replace(/,/g, "").replace(/^\$/, "").trim();
  if (!cleaned || cleaned === ".") return null;
  if (!/^\d+(\.\d*)?$/.test(cleaned) && !/^\.\d+$/.test(cleaned)) return null;
  const [wholePart, fracPart = ""] = cleaned.split(".");
  try {
    const whole = BigInt(wholePart || "0");
    const fracDigits = (fracPart + "000000").slice(0, 6);
    const frac = BigInt(fracDigits);
    return (whole * USD_MICROS_PER_DOLLAR + frac).toString();
  } catch {
    return null;
  }
}

/** Allow partial dollar typing in controlled inputs (e.g. `5.`, `.5`, `$1.2`). */
export function sanitizeDollarAmountInput(raw: string): string {
  let s = raw.replace(/,/g, "");
  const hasDollar = s.includes("$");
  s = s.replace(/\$/g, "");
  s = s.replace(/[^\d.]/g, "");
  const firstDot = s.indexOf(".");
  if (firstDot !== -1) {
    const whole = s.slice(0, firstDot).replace(/\./g, "");
    const frac = s.slice(firstDot + 1).replace(/\./g, "").slice(0, 6);
    s = `${whole}.${frac}`;
  }
  return hasDollar ? `$${s}` : s;
}
