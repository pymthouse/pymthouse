/** Convert a fiat amount string to USD micros (demo supports USD only). */

const MICROS_PER_DOLLAR = 1_000_000n;
const MAX_FRACTION_DIGITS = 6;

/** Fixed MoonPay sandbox demo amount (must be > $20). */
export const SANDBOX_ONRAMP_USD_AMOUNT = "25";

/**
 * Strict decimal → USD micros. Rejects malformed strings, non-USD, and
 * amounts that would grant 0 micros (avoids parseFloat / float rounding).
 */
export function fiatAmountToUsdMicros(
  fiatCurrencyCode: string,
  fiatAmount: string,
): bigint {
  const code = fiatCurrencyCode.trim().toUpperCase();
  if (code !== "USD") {
    throw new Error(`Unsupported fiat currency for on-ramp demo: ${code}`);
  }

  const trimmed = fiatAmount.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error("fiat amount must be a positive decimal number");
  }

  const [wholePart, fracPart = ""] = trimmed.split(".");
  if (fracPart.length > MAX_FRACTION_DIGITS) {
    throw new Error(
      `fiat amount supports at most ${MAX_FRACTION_DIGITS} decimal places`,
    );
  }

  const whole = BigInt(wholePart || "0");
  const fracDigits = (fracPart + "000000").slice(0, MAX_FRACTION_DIGITS);
  const frac = BigInt(fracDigits);
  const micros = whole * MICROS_PER_DOLLAR + frac;
  if (micros <= 0n) {
    throw new Error("fiat amount must be a positive number");
  }
  return micros;
}
