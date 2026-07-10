/** 1 USD = 1_000_000 micros (ledger / allowance). */
export const USD_MICROS_PER_DOLLAR = 1_000_000n;

/** 1 USD = 1_000_000_000 nanos (OpenMeter network_fee_usd_nanos meter). */
export const USD_NANOS_PER_DOLLAR = 1_000_000_000n;

function isIntegerAmountString(value: string): boolean {
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

function scaleFractionDigits(subunitsPerDollar: bigint): number {
  // 1e6 → 6, 1e9 → 9
  return subunitsPerDollar.toString().length - 1;
}

/**
 * Format an integer USD minor-unit amount (micros or nanos) without Number precision loss.
 * Returns null for missing, invalid, or zero values.
 */
export function formatUsdMinorUnits(
  amountStr: string | undefined | null,
  subunitsPerDollar: bigint,
  maxFractionDigits: number,
): string | null {
  if (amountStr == null || amountStr === "") return null;
  const t = amountStr.trim();
  if (!isIntegerAmountString(t)) return null;
  if (subunitsPerDollar <= 0n) return null;
  try {
    const negative = t.startsWith("-");
    const abs = BigInt(negative ? t.slice(1) : t);
    if (abs === 0n) return null;
    const whole = abs / subunitsPerDollar;
    const frac = abs % subunitsPerDollar;
    const scale = scaleFractionDigits(subunitsPerDollar);
    const digits = Math.min(scale, Math.max(0, Math.floor(maxFractionDigits)));
    const fracStr = trimFracDigitZeros(
      frac.toString().padStart(scale, "0").slice(0, digits),
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

/** Format integer USD micros (1 USD = 1e6). */
export function formatUsdMicros(
  microsStr: string | undefined | null,
  maxFractionDigits: number,
): string | null {
  return formatUsdMinorUnits(microsStr, USD_MICROS_PER_DOLLAR, maxFractionDigits);
}

/** Format integer USD nanos (1 USD = 1e9) — OpenMeter network fee meter unit. */
export function formatUsdNanos(
  nanosStr: string | undefined | null,
  maxFractionDigits: number,
): string | null {
  return formatUsdMinorUnits(nanosStr, USD_NANOS_PER_DOLLAR, maxFractionDigits);
}

function formatUsdMinorUnitsDisplay(
  amountStr: string | undefined | null,
  subunitsPerDollar: bigint,
): string {
  if (amountStr == null || amountStr === "") return "$0";
  const t = amountStr.trim();
  if (!isIntegerAmountString(t)) return "$0";
  try {
    const negative = t.startsWith("-");
    const abs = BigInt(negative ? t.slice(1) : t);
    if (abs === 0n) return "$0";
    const scale = scaleFractionDigits(subunitsPerDollar);
    // Approximate USD for digit selection only; formatting uses integer math below.
    const usdApprox = Number(abs) / Number(subunitsPerDollar);
    let digits = Math.min(6, scale);
    if (usdApprox >= 1) digits = 2;
    else if (usdApprox >= 0.01) digits = 3;
    else if (usdApprox >= 0.0001) digits = 4;
    return (
      formatUsdMinorUnits(amountStr, subunitsPerDollar, digits) ??
      `${negative ? "-" : ""}$0`
    );
  } catch {
    return "$0";
  }
}

/** Always returns a `$…` string for allowance / micros UI. */
export function formatUsdMicrosDisplay(microsStr: string | undefined | null): string {
  return formatUsdMinorUnitsDisplay(microsStr, USD_MICROS_PER_DOLLAR);
}

/** Always returns a `$…` string for OpenMeter nanos fee UI. */
export function formatUsdNanosDisplay(nanosStr: string | undefined | null): string {
  return formatUsdMinorUnitsDisplay(nanosStr, USD_NANOS_PER_DOLLAR);
}
