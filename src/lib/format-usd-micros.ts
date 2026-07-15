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

/** 1 cent = 10_000 USD micros. */
const USD_MICROS_PER_CENT = 10_000n;

/**
 * Sanitize typed USD amount input to non-negative dollars with at most 2
 * fraction digits (cents). Strips currency symbols and extra punctuation.
 */
export function sanitizeUsdCentsInput(raw: string): string {
  let s = raw.replaceAll(/[^\d.]/g, "");
  const dot = s.indexOf(".");
  if (dot !== -1) {
    s = `${s.slice(0, dot + 1)}${s.slice(dot + 1).replaceAll(".", "").slice(0, 2)}`;
  }
  return s;
}

/**
 * Convert USD micros to a cents-limited amount string for dollar inputs
 * (e.g. `"5000000"` → `"5.00"`). Truncates sub-cent remainders.
 */
export function usdMicrosToCentsDisplay(microsStr: string | null | undefined): string {
  return formatUsdMicrosDisplay(microsStr).replaceAll("$", "");
}

/**
 * Parse a cents-limited dollar amount (`"5"`, `"5.5"`, `"5.00"`) to an integer
 * USD micros string. Returns null for empty/invalid input. Storage stays in
 * micros; the UI never exposes more than cents.
 */
export function usdCentsDisplayToMicros(display: string): string | null {
  const t = display.trim().replace(/\.$/, "");
  if (!t || !/^\d+(\.\d{1,2})?$/.test(t)) return null;
  try {
    const [wholePart, fracPart = ""] = t.split(".");
    const whole = BigInt(wholePart);
    const cents = BigInt((fracPart + "00").slice(0, 2));
    return (whole * USD_MICROS_PER_DOLLAR + cents * USD_MICROS_PER_CENT).toString();
  } catch {
    return null;
  }
}

/**
 * Normalize a typed dollar amount to fixed cents (`"5"` → `"5.00"`).
 * Returns the original trimmed string when it is not yet a complete amount.
 */
export function normalizeUsdCentsDisplay(display: string): string {
  const micros = usdCentsDisplayToMicros(display);
  if (micros == null) return display.trim();
  return usdMicrosToCentsDisplay(micros);
}
