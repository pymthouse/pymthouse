import {
  formatUsdMicrosSummary,
  parseUsdMicrosString,
} from "@/lib/format-usd-micros";
import { decimalDollarsToUsdMicros } from "@/lib/openmeter/konnect-credits";
import { resolveOwnerTierOverageRateUsd } from "@/lib/billing/owner-subscription-tiers";

/**
 * Rough call-count label for Upgrade cards (e.g. 5_000_000 → "5 M").
 * @internal Exported for unit tests.
 */
export function formatRoughApiCallCount(calls: bigint): string {
  if (calls <= 0n) return "0";
  if (calls >= 1_000_000n) {
    const millions = Number(calls) / 1_000_000;
    const rounded = Math.round(millions * 10) / 10;
    return `${rounded} M`;
  }
  if (calls >= 1_000n) {
    return `${Math.round(Number(calls) / 1_000)} K`;
  }
  return calls.toString();
}

/**
 * Estimate included API calls from allowance ÷ per-call overage rate.
 * @internal Exported for unit tests.
 */
export function estimateIncludedApiCalls(
  includedUsdMicros: string,
  overageRateUsd?: string | null,
): bigint | null {
  const micros = parseUsdMicrosString(includedUsdMicros);
  if (micros == null || micros <= 0n) return null;
  const rate = resolveOwnerTierOverageRateUsd(overageRateUsd);
  let rateMicros: bigint;
  try {
    rateMicros = decimalDollarsToUsdMicros(rate);
  } catch {
    return null;
  }
  if (rateMicros <= 0n) return null;
  return micros / rateMicros;
}

/** First checkout bullet — always derived from live tier numbers. */
export function ownerTierIncludedUsageBullet(
  includedUsdMicros: string,
  overageRateUsd?: string | null,
): string {
  const included = formatUsdMicrosSummary(includedUsdMicros);
  const calls = estimateIncludedApiCalls(includedUsdMicros, overageRateUsd);
  if (calls == null) {
    return `${included} included usage each billing cycle`;
  }
  return `${included} included usage — roughly ${formatRoughApiCallCount(calls)} API calls at standard rate`;
}

function splitAdminDescription(description: string | null | undefined): string[] {
  if (!description?.trim()) return [];
  return description
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Checkout bullet list for a paid tier: live included-usage line first, then
 * admin description lines (newline-separated) or static feature bullets.
 */
export function buildOwnerTierCheckoutBullets(input: {
  includedUsdMicros: string;
  overageRateUsd?: string | null;
  description?: string | null;
  featureBullets?: string[];
}): string[] {
  const bullets = [
    ownerTierIncludedUsageBullet(
      input.includedUsdMicros,
      input.overageRateUsd,
    ),
  ];
  const admin = splitAdminDescription(input.description);
  if (admin.length > 0) {
    bullets.push(...admin);
    return bullets;
  }
  if (input.featureBullets?.length) {
    bullets.push(...input.featureBullets);
  }
  return bullets;
}
