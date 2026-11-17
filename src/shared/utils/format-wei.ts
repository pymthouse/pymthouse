const WEI_PER_GWEI = 10n ** 9n;
const WEI_PER_ETH = 10n ** 18n;
/** Values at or above this display as ETH (0.001 ETH). */
const ETH_DISPLAY_THRESHOLD = WEI_PER_ETH / 1000n;

function trimTrailingZeros(s: string): string {
  return s.replace(/0+$/, "").replace(/\.$/, "");
}

function formatEthFraction(rem: bigint, maxDigits: number): string {
  if (rem === 0n) return "";
  const frac = rem.toString().padStart(18, "0").slice(0, maxDigits);
  return trimTrailingZeros(frac);
}

/** Integer string for the first `decimals` fractional gwei digits (floored). */
function subGweiFractionalDigits(weiRem: bigint, decimals: number): string {
  if (weiRem === 0n) return "";
  const mult = 10n ** BigInt(decimals);
  const q = (weiRem * mult) / WEI_PER_GWEI;
  return trimTrailingZeros(q.toString().padStart(decimals, "0"));
}

/**
 * Human-readable wei: gwei when below 0.001 ETH, otherwise ETH with trimmed
 * fractional digits (no dependency — BigInt-safe).
 */
export function formatWeiHuman(weiStr: string | null | undefined): string {
  const raw = (weiStr ?? "").trim() || "0";
  let w: bigint;
  try {
    w = BigInt(raw);
  } catch {
    return raw;
  }
  if (w === 0n) return "0";

  if (w >= ETH_DISPLAY_THRESHOLD) {
    const whole = w / WEI_PER_ETH;
    const rem = w % WEI_PER_ETH;
    const frac = formatEthFraction(rem, 8);
    return frac ? `${whole.toString()}.${frac}` : whole.toString();
  }

  const gWhole = w / WEI_PER_GWEI;
  const gRem = w % WEI_PER_GWEI;
  if (gRem === 0n) return gWhole.toString();
  const frac = subGweiFractionalDigits(gRem, 6);
  if (frac) return `${gWhole.toString()}.${frac}`;
  // Remainder wei is nonzero but rounds to 0 at 6 fractional gwei digits; 9 digits
  // resolve sub-gwei wei exactly (1 gwei = 1e9 wei).
  const fracFine = subGweiFractionalDigits(gRem, 9);
  if (fracFine) return `${gWhole.toString()}.${fracFine}`;
  return "<0.000001 gwei";
}

/** Wei column label helper: value + unit suffix for table headers. */
export function weiHumanWithUnit(weiStr: string | null | undefined): string {
  const raw = (weiStr ?? "").trim() || "0";
  let w: bigint;
  try {
    w = BigInt(raw);
  } catch {
    return raw;
  }
  if (w === 0n) return "0";
  const n = formatWeiHuman(raw);
  if (w >= ETH_DISPLAY_THRESHOLD) return `${n} ETH`;
  return `${n} gwei`;
}

export function formatIntegerString(
  s: string | null | undefined,
): string | null {
  if (s == null || s === "") return null;
  try {
    return BigInt(s).toLocaleString();
  } catch {
    return s;
  }
}
