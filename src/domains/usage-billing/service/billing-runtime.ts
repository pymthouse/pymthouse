/**
 * Runtime billing engine for PymtHouse.
 *
 * Provides small, independently testable functions that are called from
 * signer and usage-reporting flows after the remote signer succeeds.
 */

import crypto from "crypto";
import { extractPipelineModelFromCapabilitiesBase64 } from "@/platform/livepeer/proto";

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
  pricingRuleSource: "pipeline_model" | "general" | "pay_per_use" | "subscription_included" | "unpriced";
}

interface UsageBillingPlanLike {
  generalUpchargePercentBps: number | null;
  payPerUseUpchargePercentBps: number | null;
}

interface UsageBillingBundleLike {
  pipeline: string;
  modelId: string;
  upchargePercentBps: number | null;
}

function pickString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

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

export function resolveUpcharge(params: {
  plan: UsageBillingPlanLike | null;
  bundles: Array<UsageBillingBundleLike>;
  pipeline: string;
  modelId: string;
}): { bps: number; source: BillingContext["pricingRuleSource"] } {
  const { plan, bundles, pipeline, modelId } = params;

  const bundle =
    bundles.find((entry) => entry.pipeline === pipeline && entry.modelId === modelId) ??
    bundles.find((entry) => entry.pipeline === pipeline && entry.modelId === "*");
  if (bundle?.upchargePercentBps != null && bundle.upchargePercentBps >= 0) {
    return { bps: bundle.upchargePercentBps, source: "pipeline_model" };
  }

  if (plan?.generalUpchargePercentBps != null && plan.generalUpchargePercentBps >= 0) {
    return { bps: plan.generalUpchargePercentBps, source: "general" };
  }

  if (
    plan?.payPerUseUpchargePercentBps != null &&
    plan.payPerUseUpchargePercentBps >= 0
  ) {
    return { bps: plan.payPerUseUpchargePercentBps, source: "pay_per_use" };
  }

  return { bps: 0, source: "unpriced" };
}

export function computeUsdMicrosFromWei(weiAmt: bigint, ethUsdPriceUsd: number): bigint {
  if (weiAmt <= 0n || !Number.isFinite(ethUsdPriceUsd) || ethUsdPriceUsd <= 0) {
    return 0n;
  }
  const ethUsdMicros = BigInt(Math.floor(ethUsdPriceUsd * 1_000_000));
  const divisor = 10n ** 18n;
  return (weiAmt * ethUsdMicros) / divisor;
}

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
