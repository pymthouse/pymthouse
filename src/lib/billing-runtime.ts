/**
 * Runtime billing engine for PymtHouse.
 *
 * Provides small, independently testable functions that are called from
 * the OpenMeter Kafka collector after go-livepeer emits create_signed_ticket events.
 *
 * Core invariant:
 *   Metered usage is authoritative in OpenMeter/Konnect (Kafka collector path).
 *   This module retains pricing helpers for pipeline/model constraint parsing.
 */

import crypto from "crypto";
import { extractPipelineModelFromCapabilitiesBase64 } from "./proto";

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

export interface BillingContext {
  planId: string | null;
  subscriptionId: string | null;
  upchargePercentBps: number;
  pricingRuleSource: "pipeline_model" | "subscription_included" | "unpriced";
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
 * Resolve pipeline/model for billing: explicit body fields first, then
 * base64-encoded `net.Capabilities` (`capabilities` field), matching the Go
 * remote signer payment request shape.
 */
export async function resolvePaymentPipelineModelConstraint(
  requestBody: Record<string, unknown>,
): Promise<PipelineModelConstraint | null> {
  const direct = resolveRequestPipelineModelConstraint(requestBody);
  if (direct) return direct;

  const capsB64 =
    pickString(requestBody, "capabilities") ??
    pickString(requestBody, "Capabilities");
  if (!capsB64) return null;

  const fromCaps = await extractPipelineModelFromCapabilitiesBase64(capsB64);
  if (!fromCaps) return null;
  return { pipeline: fromCaps.pipeline, modelId: fromCaps.modelId };
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
 * Build a stable, deterministic constraint hash.
 * The hash covers the five facts that uniquely identify a priced pipeline/model
 * slot on a specific orchestrator (pipeline, modelId, orch, wei/unit, pixels/unit).
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
 * Constraint hash for the negotiated ticket: same tuple as buildConstraintHash,
 * using the signed wei/unit and pixels/unit strings from the request.
 */
export function buildSignedTicketConstraintHash(params: {
  pipeline: string;
  modelId: string;
  orchAddress: string;
  signedPriceWeiPerUnit: string;
  signedPixelsPerUnit: string;
}): string {
  return buildConstraintHash({
    pipeline: params.pipeline,
    modelId: params.modelId,
    orchAddress: params.orchAddress,
    priceWeiPerUnit: params.signedPriceWeiPerUnit,
    pixelsPerUnit: params.signedPixelsPerUnit,
  });
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
