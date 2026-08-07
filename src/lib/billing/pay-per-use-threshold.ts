/**
 * Threshold-only invoicing/charging semantics for Pay-Per-Use plans (issue #398).
 *
 * Konnect capability investigation outcome: OpenMeter/Konnect plans REQUIRE a
 * `billingCadence` (ISO-8601 period — see plans-sync.ts / billing-cycle.ts) and
 * billing profiles carry no cycle of their own, so a truly cycle-less plan is
 * not representable. Per the issue's documented fallback, Pay-Per-Use plans
 * keep a NOMINAL internal cycle for Konnect's sake (a no-op reconciliation
 * boundary, never the primary charge trigger) and all charging is driven by
 * the charge threshold: progressive billing + the clearinghouse threshold
 * worker invoice when accrued usage reaches the threshold, settling prepaid
 * credits first, then auto-debiting the default payment method.
 *
 * Client-safe (no DB/Node imports) so the plan dialog can render the resolved
 * behaviour live.
 */

/** Internal cycle kept only so OpenMeter/Konnect accepts the plan. */
export const PAY_PER_USE_NOMINAL_BILLING_CYCLE = "monthly";

/** Plan `type` value that gets threshold-only semantics. */
export function isPayPerUsePlanType(type: string | null | undefined): boolean {
  return type?.trim().toLowerCase() === "usage";
}

const MAX_THRESHOLD_USD = 1_000_000;

/**
 * Parse a builder-supplied charge threshold in whole dollars (string or
 * number, up to 2 decimals) into USD micros. Empty input clears the threshold.
 */
export function parseChargeThresholdUsdInput(
  value: unknown,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") {
    return { ok: true, value: null };
  }
  let raw: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return { ok: false, error: "chargeThresholdUsd must be a decimal dollar amount" };
    }
    raw = String(value);
  } else if (typeof value === "string") {
    raw = value.trim();
    if (!raw) {
      return { ok: true, value: null };
    }
  } else {
    return { ok: false, error: "chargeThresholdUsd must be a decimal dollar amount" };
  }

  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(raw);
  if (!match) {
    return {
      ok: false,
      error: "chargeThresholdUsd must be a positive dollar amount with up to 2 decimals",
    };
  }
  const dollars = Number.parseInt(match[1], 10);
  const centsPart = (match[2] ?? "").padEnd(2, "0");
  const cents = centsPart ? Number.parseInt(centsPart, 10) : 0;
  const micros = BigInt(dollars) * 1_000_000n + BigInt(cents) * 10_000n;
  if (micros <= 0n) {
    return { ok: false, error: "chargeThresholdUsd must be greater than 0" };
  }
  if (dollars > MAX_THRESHOLD_USD) {
    return {
      ok: false,
      error: `chargeThresholdUsd must be at most $${MAX_THRESHOLD_USD.toLocaleString("en-US")}`,
    };
  }
  return { ok: true, value: micros.toString() };
}

/** `"10000000"` micros → `"10.00"` (at least 2 decimals, extras trimmed). */
export function formatUsdMicrosForDisplay(usdMicros: string): string {
  let micros: bigint;
  try {
    micros = BigInt(usdMicros);
  } catch {
    return "0.00";
  }
  if (micros < 0n) {
    micros = 0n;
  }
  const dollars = micros / 1_000_000n;
  const fraction = (micros % 1_000_000n).toString().padStart(6, "0");
  const trimmed = fraction.replace(/0+$/, "");
  const decimals = trimmed.length <= 2 ? fraction.slice(0, 2) : trimmed;
  return `${dollars.toString()}.${decimals}`;
}

/**
 * Plain-language reading of a Pay-Per-Use plan's settlement behaviour
 * (#348 resolved-behavior pattern). Rendering this avoids the reader inferring
 * cycle-based invoicing from a plan that has no user-facing cycle.
 */
export function resolvedPayPerUseBehavior(
  chargeThresholdUsdMicros: string | null | undefined,
): string {
  const threshold = chargeThresholdUsdMicros?.trim();
  if (!threshold) {
    return "Pay-per-use — usage settles against prepaid credits; no auto-debit threshold set.";
  }
  return `Pay-per-use — charged at every $${formatUsdMicrosForDisplay(threshold)} of usage (credits first).`;
}
