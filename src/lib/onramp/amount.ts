/** Convert a fiat amount string to USD micros (demo supports USD only). */
export function fiatAmountToUsdMicros(
  fiatCurrencyCode: string,
  fiatAmount: string,
): bigint {
  const code = fiatCurrencyCode.trim().toUpperCase();
  const amount = Number.parseFloat(fiatAmount.trim());
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("fiat amount must be a positive number");
  }
  if (code !== "USD") {
    throw new Error(`Unsupported fiat currency for on-ramp demo: ${code}`);
  }
  return BigInt(Math.round(amount * 1_000_000));
}
