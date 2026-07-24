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

/** Format a non-negative dollar amount from whole + fractional digit string. */
function formatDollarParts(whole: bigint, fracDigits: string): string {
  const frac = trimFracDigitZeros(
    fracDigits.length > 12 ? fracDigits.slice(0, 12) : fracDigits,
  );
  if (frac.length === 0) {
    return `$${whole.toString()}`;
  }
  return `$${whole.toString()}.${frac}`;
}

/**
 * Parse Wei strings from collector / OpenMeter (`"123"`, `"123.0"`, scientific).
 * Returns null when missing, non-numeric, or non-positive.
 */
function parseWeiString(raw: string): bigint | null {
  const t = raw.trim();
  if (!t) return null;
  if (/^\d+$/.test(t)) {
    try {
      const wei = BigInt(t);
      return wei > 0n ? wei : null;
    } catch {
      return null;
    }
  }
  // Bloblang float.string() may emit "123.0" or scientific notation.
  if (/^\d+\.0+$/.test(t)) {
    try {
      const wei = BigInt(t.slice(0, t.indexOf(".")));
      return wei > 0n ? wei : null;
    } catch {
      return null;
    }
  }
  if (!/^\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t)) return null;
  const asNumber = Number(t);
  if (!Number.isFinite(asNumber) || asNumber <= 0) return null;
  if (asNumber > Number.MAX_SAFE_INTEGER) return null;
  const wei = BigInt(Math.trunc(asNumber));
  return wei > 0n ? wei : null;
}

/**
 * Format exact USD from Wei and ETH/USD price:
 *   usd = fee_wei * eth_usd / 1e18
 * Renders full precision for sub-micro tickets (e.g. `$0.00000025`).
 * Returns null for missing/invalid inputs or zero.
 */
export function formatUsdFromWei(
  feeWei: string | null | undefined,
  ethUsdPrice: string | null | undefined,
): string | null {
  if (feeWei == null || ethUsdPrice == null) return null;
  const priceTrim = ethUsdPrice.trim();
  if (!priceTrim) return null;
  const price = Number(priceTrim);
  if (!Number.isFinite(price) || price <= 0) return null;
  try {
    const wei = parseWeiString(feeWei);
    if (wei == null) return null;
    // dollars = wei * price / 1e18 ≈ (wei * floor(price*1e6)) / 1e24
    const ethUsdMicros = BigInt(Math.floor(price * 1_000_000));
    const product = wei * ethUsdMicros;
    const DOLLAR_DIV = 10n ** 24n;
    const dollarWhole = product / DOLLAR_DIV;
    const dollarRem = product % DOLLAR_DIV;
    if (dollarWhole === 0n && dollarRem === 0n) return null;
    return formatDollarParts(dollarWhole, dollarRem.toString().padStart(24, "0"));
  } catch {
    return null;
  }
}

/**
 * Format ticket/request USD from integer or fractional micros (exact ingest).
 * Fractional values are rendered exactly so sub-micro tickets never appear as $0.
 * Integer micros keep the ledger floor label via {@link formatUsdMicrosString}.
 */
export function formatExactUsdMicrosString(
  microsStr: string | null | undefined,
): string | null {
  if (microsStr == null || microsStr === "") return null;
  const t = microsStr.trim();
  if (isIntegerMicrosString(t)) {
    return formatUsdMicrosString(t);
  }
  if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t)) return null;
  const micros = Number(t);
  if (!Number.isFinite(micros) || micros === 0) return null;
  const negative = micros < 0;
  const dollars = Math.abs(micros) / 1_000_000;
  // 12 fraction digits matches formatUsdFromWei display cap.
  // Trim trailing zeros without /.?0+$/ (Sonar S8786 backtracking).
  let fixed = dollars.toFixed(12);
  if (fixed.includes(".")) {
    const [whole, frac = ""] = fixed.split(".");
    const trimmedFrac = trimFracDigitZeros(frac);
    fixed = trimmedFrac ? `${whole}.${trimmedFrac}` : whole;
  }
  if (fixed === "0") return null;
  return `${negative ? "-" : ""}$${fixed}`;
}

/** 1 cent = 10_000 USD micros. */
const USD_MICROS_PER_CENT = 10_000n;

/**
 * Ceil USD micros up to the next whole cent (10_000 micros).
 * Invoice line policy: round line totals up so merchants are not under-billed.
 */
export function ceilUsdMicrosToCents(microsStr: string | null | undefined): string {
  const amount = parseUsdMicrosString(microsStr);
  if (amount == null || amount <= 0n) return "0";
  const rem = amount % USD_MICROS_PER_CENT;
  if (rem === 0n) return amount.toString();
  return (amount + (USD_MICROS_PER_CENT - rem)).toString();
}

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
