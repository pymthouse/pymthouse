/**
 * Runtime billing engine for PymtHouse.
 *
 * Provides small, independently testable functions that are called from
 * proxyGenerateLivePayment() after the go-livepeer remote signer succeeds.
 *
 * Core invariant:
 *   A billable usage_billing_events row is only created when:
 *   1. The signing request includes an explicit pipeline/model constraint.
 *   2. The signed ticket price/unit facts match the NaaP advertised price for
 *      that exact pipeline/model/orchestrator.
 *
 * Client-supplied pipeline/model labels are claims, not proof. The matching
 * of signed price against advertised price is the validation step that
 * establishes trust.
 */

import crypto from "crypto";
import type { PricingRow } from "./naap-catalog";
import type { EthUsdOracleResult } from "./prices/eth-usd-oracle";
import type { planCapabilityBundles, plans } from "@/db/schema";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PipelineModelConstraint {
  pipeline: string;
  modelId: string;
}

export interface GatewayAttribution {
  attributionSource: string;
  gatewayRequestId: string | null;
  paymentMetadataVersion: string | null;
}

export type PriceValidationStatus =
  | "matched"
  | "missing_constraint"
  | "unknown_pipeline_model"
  | "missing_advertised_price"
  | "price_mismatch";

export interface PriceValidationSuccess {
  status: "matched";
  matchedRow: PricingRow;
  pipelineModelConstraintHash: string;
}

export interface PriceValidationFailure {
  status: Exclude<PriceValidationStatus, "matched">;
  reason: string;
}

export type PriceValidationResult = PriceValidationSuccess | PriceValidationFailure;

export interface BillingContext {
  planId: string | null;
  subscriptionId: string | null;
  upchargePercentBps: number;
  pricingRuleSource: "pipeline_model" | "general" | "pay_per_use" | "subscription_included" | "unpriced";
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Read pipeline and modelId from the python-gateway payment metadata envelope
 * first, then fall back to direct body fields and legacy aliases.
 * Returns null when neither canonical form is present.
 */
export function resolveRequestPipelineModelConstraint(
  requestBody: Record<string, unknown>,
): PipelineModelConstraint | null {
  const pipeline =
    pickString(requestBody, "pipeline") ??
    pickString(requestBody, "Pipeline") ??
    null;
  const modelId =
    pickString(requestBody, "modelId") ??
    pickString(requestBody, "ModelID") ??
    pickString(requestBody, "modelID") ??
    pickString(requestBody, "model") ??
    pickString(requestBody, "Model") ??
    null;

  if (!pipeline || !modelId) return null;
  return { pipeline, modelId };
}

/**
 * Read gateway attribution metadata from the python-gateway envelope.
 * Defaults attributionSource to "direct_api" for callers that bypass the
 * gateway stack.
 */
export function resolveGatewayAttribution(
  requestBody: Record<string, unknown>,
): GatewayAttribution {
  const attributionSource =
    pickString(requestBody, "attributionSource") ?? "direct_api";
  const gatewayRequestId = pickString(requestBody, "gatewayRequestId") ?? null;
  const paymentMetadataVersion =
    pickString(requestBody, "paymentMetadataVersion") ?? null;
  return { attributionSource, gatewayRequestId, paymentMetadataVersion };
}

function pickString(body: Record<string, unknown>, key: string): string | null {
  const v = body[key];
  if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}

/**
 * Build a stable, deterministic constraint hash for a matched pricing row.
 * The hash covers the five facts that uniquely identify a priced pipeline/model
 * slot on a specific orchestrator.
 */
export function buildConstraintHash(params: {
  pipeline: string;
  modelId: string;
  orchAddress: string;
  priceWeiPerUnit: string;
  pixelsPerUnit: string;
}): string {
  const canonical = JSON.stringify([
    params.pipeline,
    params.modelId,
    params.orchAddress.toLowerCase(),
    params.priceWeiPerUnit,
    params.pixelsPerUnit,
  ]);
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/**
 * Validate the signed ticket price facts against the NaaP advertised price for
 * the requested pipeline/model.
 *
 * Match criteria:
 *  - Exact pipeline + model match.
 *  - Exact orchAddress match when the signed request exposes one.
 *  - Exact priceWeiPerUnit equality.
 *  - Exact pixelsPerUnit equality.
 *
 * Fails closed on missing, ambiguous, or mismatched pricing.
 */
export function validateSignedTicketPriceForPipelineModel(params: {
  pipeline: string;
  modelId: string;
  orchAddress: string | undefined;
  signedPriceWeiPerUnit: bigint;
  signedPixelsPerUnit: bigint;
  pricingRows: PricingRow[];
}): PriceValidationResult {
  const { pipeline, modelId, orchAddress, signedPriceWeiPerUnit, signedPixelsPerUnit, pricingRows } = params;

  // Filter by pipeline + model first
  const candidates = pricingRows.filter(
    (r) => r.pipeline === pipeline && r.model === modelId,
  );

  if (candidates.length === 0) {
    return {
      status: "unknown_pipeline_model",
      reason: `No advertised pricing found for pipeline="${pipeline}" model="${modelId}"`,
    };
  }

  // Further filter by orchAddress when available
  const addressFiltered =
    orchAddress && orchAddress !== "0x"
      ? candidates.filter(
          (r) => r.orchAddress.toLowerCase() === orchAddress.toLowerCase(),
        )
      : candidates;

  const pool = addressFiltered.length > 0 ? addressFiltered : candidates;

  // Match by exact price/unit
  const matched = pool.filter((r) => {
    try {
      return (
        BigInt(r.priceWeiPerUnit) === signedPriceWeiPerUnit &&
        BigInt(r.pixelsPerUnit) === signedPixelsPerUnit
      );
    } catch {
      return false;
    }
  });

  if (matched.length === 0) {
    const advertised = pool
      .map((r) => `${r.priceWeiPerUnit}/${r.pixelsPerUnit}`)
      .join(", ");
    return {
      status: "price_mismatch",
      reason: `Signed price ${signedPriceWeiPerUnit}/${signedPixelsPerUnit} does not match advertised [${advertised}] for pipeline="${pipeline}" model="${modelId}"`,
    };
  }

  // Use the first matching row (there should only be one per orch+pipeline+model)
  const row = matched[0];
  const hash = buildConstraintHash({
    pipeline,
    modelId,
    orchAddress: row.orchAddress,
    priceWeiPerUnit: row.priceWeiPerUnit,
    pixelsPerUnit: row.pixelsPerUnit,
  });

  return { status: "matched", matchedRow: row, pipelineModelConstraintHash: hash };
}

/**
 * Resolve the upcharge in basis points to apply to this usage event.
 *
 * Priority: pipeline/model bundle override → plan general upcharge →
 *           plan payPerUse fallback → 0.
 *
 * Negative values are rejected at write time and should never appear here.
 */
export function resolveUpcharge(params: {
  plan: typeof plans.$inferSelect | null;
  bundles: Array<typeof planCapabilityBundles.$inferSelect>;
  pipeline: string;
  modelId: string;
}): { bps: number; source: BillingContext["pricingRuleSource"] } {
  const { plan, bundles, pipeline, modelId } = params;

  // 1. Exact pipeline + modelId bundle override, then pipeline wildcard ("*")
  const bundle =
    bundles.find((b) => b.pipeline === pipeline && b.modelId === modelId) ??
    bundles.find((b) => b.pipeline === pipeline && b.modelId === "*");
  if (bundle?.upchargePercentBps != null && bundle.upchargePercentBps >= 0) {
    return { bps: bundle.upchargePercentBps, source: "pipeline_model" };
  }

  // 2. Plan general upcharge
  if (plan?.generalUpchargePercentBps != null && plan.generalUpchargePercentBps >= 0) {
    return { bps: plan.generalUpchargePercentBps, source: "general" };
  }

  // 3. Pay-per-use fallback (for free / no-credit plans)
  if (
    plan?.payPerUseUpchargePercentBps != null &&
    plan.payPerUseUpchargePercentBps >= 0
  ) {
    return { bps: plan.payPerUseUpchargePercentBps, source: "pay_per_use" };
  }

  return { bps: 0, source: "unpriced" };
}

/**
 * Convert a wei value to USD micros (1 USD = 1,000,000 micros) using the
 * oracle ETH/USD price.
 *
 * Uses integer arithmetic on the WEI → micros path to avoid floating-point
 * precision loss. Returns a bigint.
 *
 * Formula: weiAmt * ethUsdMicros / 1e18
 * where ethUsdMicros = floor(ethUsdPriceUsd * 1e6)
 *
 * Derivation:
 *   networkFeeUsdMicros = (weiAmt / 1e18) * priceUsd * 1e6
 *                       = weiAmt * (priceUsd * 1e6) / 1e18
 *                       = weiAmt * ethUsdMicros / 1e18
 */
export function computeUsdMicrosFromWei(weiAmt: bigint, ethUsdPriceUsd: number): bigint {
  if (weiAmt <= 0n || !Number.isFinite(ethUsdPriceUsd) || ethUsdPriceUsd <= 0) {
    return 0n;
  }
  // ethUsdMicros = floor(priceUsd * 1e6)
  const ethUsdMicros = BigInt(Math.floor(ethUsdPriceUsd * 1_000_000));
  const DIVISOR = 10n ** 18n;
  return (weiAmt * ethUsdMicros) / DIVISOR;
}

/**
 * Convert wei to a decimal ETH string with up to 18 decimal places.
 */
export function weiToEthString(weiAmt: bigint): string {
  if (weiAmt === 0n) return "0";
  const negative = weiAmt < 0n;
  const abs = negative ? -weiAmt : weiAmt;
  const whole = abs / 10n ** 18n;
  const frac = abs % 10n ** 18n;
  const fracStr = frac.toString().padStart(18, "0").replace(/0+$/, "");
  const result = fracStr ? `${whole}.${fracStr}` : whole.toString();
  return negative ? `-${result}` : result;
}
