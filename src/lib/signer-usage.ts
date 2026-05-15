import { db } from "@/db/index";
import {
  planCapabilityBundles,
  plans,
  signerConfig,
  streamSessions,
  transactions,
  usageBillingEvents,
  usageRecords,
} from "@/db/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import type { AuthResult } from "./auth";
import { getEthUsdOracle } from "./prices/eth-usd-oracle";
import {
  type PipelineModelConstraint,
  type GatewayAttribution,
  buildSignedTicketConstraintHash,
  resolveUpcharge,
  computeUsdMicrosFromWei,
} from "./billing-runtime";

export interface RecordLivePaymentUsageArgs {
  auth: AuthResult;
  requestBody: Record<string, unknown>;
  signer: typeof signerConfig.$inferSelect;
  providerAppId: string | null;
  usageUserId: string | null;
  feeWei: bigint;
  platformCutWei: bigint;
  pricePerUnit: bigint;
  pixelsPerUnit: bigint;
  pixels: bigint;
  streamSessionId: string | null;
  constraint: PipelineModelConstraint | null;
  attribution: GatewayAttribution;
  orchestratorAddress: string | undefined;
}

/**
 * Persist usage / billing rows after a successful `generate-live-payment`
 * (legacy go-livepeer or LPNM payer-daemon path).
 */
export async function recordLivePaymentUsage(
  args: RecordLivePaymentUsageArgs,
): Promise<void> {
  const {
    auth,
    requestBody,
    signer,
    providerAppId,
    usageUserId,
    feeWei,
    platformCutWei,
    pricePerUnit,
    pixelsPerUnit,
    pixels,
    streamSessionId,
    constraint,
    attribution,
    orchestratorAddress,
  } = args;

  const orchAddrForConstraint =
    orchestratorAddress && orchestratorAddress.length > 0
      ? orchestratorAddress
      : "0x";

  const signedPriceStr = pricePerUnit.toString();
  const signedPixelsStr = pixelsPerUnit.toString();
  const pipelineModelConstraintHash =
    constraint !== null
      ? buildSignedTicketConstraintHash({
          pipeline: constraint.pipeline,
          modelId: constraint.modelId,
          orchAddress: orchAddrForConstraint,
          signedPriceWeiPerUnit: signedPriceStr,
          signedPixelsPerUnit: signedPixelsStr,
        })
      : null;

  let priceValidationStatus: string;
  let priceValidationReason: string | undefined;
  if (!constraint) {
    priceValidationStatus = "missing_constraint";
    priceValidationReason =
      "No pipeline/model in request (add pipeline and modelId or capabilities with PerCapability models) for full attribution.";
  } else {
    priceValidationStatus = "matched";
  }

  const rawReq =
    (typeof requestBody.requestId === "string" && requestBody.requestId.trim()) ||
    (typeof requestBody.RequestID === "string" && requestBody.RequestID.trim());
  const requestId = rawReq || uuidv4();

  let existingUsage = null;
  if (providerAppId) {
    const usageRows = await db
      .select()
      .from(usageRecords)
      .where(
        and(
          eq(usageRecords.clientId, providerAppId),
          eq(usageRecords.requestId, requestId),
        ),
      )
      .limit(1);
    existingUsage = usageRows[0] ?? null;
  }

  if (existingUsage) return;

  const ethUsd = await getEthUsdOracle();

  const networkFeeUsdMicros = computeUsdMicrosFromWei(feeWei, ethUsd.priceUsd);
  const ownerChargeWei = feeWei + platformCutWei;
  const ownerPlatformFeeUsdMicros = computeUsdMicrosFromWei(
    platformCutWei,
    ethUsd.priceUsd,
  );
  const ownerChargeUsdMicros = computeUsdMicrosFromWei(ownerChargeWei, ethUsd.priceUsd);

  let upchargeResult: {
    bps: number;
    source: "pipeline_model" | "general" | "pay_per_use" | "subscription_included" | "unpriced";
  } = { bps: 0, source: "unpriced" as const };
  if (providerAppId && constraint) {
    try {
      const planRows = await db
        .select()
        .from(plans)
        .where(and(eq(plans.clientId, providerAppId), eq(plans.status, "active")))
        .orderBy(desc(plans.updatedAt))
        .limit(1);
      const bundleRows = planRows[0]
        ? await db
            .select()
            .from(planCapabilityBundles)
            .where(
              and(
                eq(planCapabilityBundles.planId, planRows[0].id),
                eq(planCapabilityBundles.clientId, providerAppId),
              ),
            )
        : [];
      upchargeResult = resolveUpcharge({
        plan: planRows[0] ?? null,
        bundles: bundleRows,
        pipeline: constraint.pipeline,
        modelId: constraint.modelId,
      });
    } catch (err) {
      console.warn("[proxy] Plan upcharge lookup failed:", err);
    }
  }

  const endUserBillableUsdMicros =
    upchargeResult.bps > 0
      ? networkFeeUsdMicros + (networkFeeUsdMicros * BigInt(upchargeResult.bps)) / 10000n
      : networkFeeUsdMicros;

  const transactionId = uuidv4();
  const usageRecordId = uuidv4();
  const nowIso = new Date().toISOString();

  await db.transaction(async (tx) => {
    if (streamSessionId) {
      await tx
        .update(streamSessions)
        .set({
          signerPaymentCount: sql`${streamSessions.signerPaymentCount} + 1`,
          totalFeeWei: sql`(${streamSessions.totalFeeWei}::numeric + ${feeWei.toString()}::numeric)::bigint::text`,
          lastPaymentAt: nowIso,
          pricePerUnit: pricePerUnit.toString(),
          pixelsPerUnit: pixelsPerUnit.toString(),
        })
        .where(eq(streamSessions.id, streamSessionId));
    }

    await tx.insert(transactions).values({
      id: transactionId,
      endUserId: auth.endUserId || null,
      appId: providerAppId ?? auth.appId ?? null,
      clientId: providerAppId,
      streamSessionId,
      type: "usage",
      amountWei: feeWei.toString(),
      platformCutPercent: signer.defaultCutPercent,
      platformCutWei: platformCutWei.toString(),
      status: "confirmed",
      pipeline: constraint?.pipeline ?? null,
      modelId: constraint?.modelId ?? null,
      attributionSource: attribution.attributionSource,
      gatewayRequestId: attribution.gatewayRequestId,
      paymentMetadataVersion: attribution.paymentMetadataVersion,
      pipelineModelConstraintHash,
      advertisedPriceWeiPerUnit: constraint ? signedPriceStr : null,
      advertisedPixelsPerUnit: constraint ? signedPixelsStr : null,
      signedPriceWeiPerUnit: pricePerUnit.toString(),
      signedPixelsPerUnit: pixelsPerUnit.toString(),
      priceValidationStatus,
      priceValidationReason: priceValidationReason ?? null,
      ethUsdPrice: ethUsd.priceUsd.toString(),
      ethUsdSource: ethUsd.source,
      ethUsdObservedAt: ethUsd.observedAt,
      networkFeeUsdMicros: networkFeeUsdMicros.toString(),
      ownerPlatformFeeWei: platformCutWei.toString(),
      ownerPlatformFeeUsdMicros: ownerPlatformFeeUsdMicros.toString(),
      ownerChargeWei: ownerChargeWei.toString(),
      ownerChargeUsdMicros: ownerChargeUsdMicros.toString(),
    });

    if (providerAppId) {
      const clientId = providerAppId;
      await tx.insert(usageRecords).values({
        id: usageRecordId,
        requestId,
        userId: usageUserId,
        clientId,
        modelId: constraint?.modelId ?? null,
        units: pixels.toString(),
        fee: feeWei.toString(),
        createdAt: new Date().toISOString(),
      });

      if (constraint && pipelineModelConstraintHash) {
        await tx.insert(usageBillingEvents).values({
          id: uuidv4(),
          usageRecordId,
          transactionId,
          streamSessionId,
          clientId,
          userId: usageUserId,
          pipeline: constraint.pipeline,
          modelId: constraint.modelId,
          attributionSource: attribution.attributionSource,
          gatewayRequestId: attribution.gatewayRequestId,
          paymentMetadataVersion: attribution.paymentMetadataVersion,
          pipelineModelConstraintHash: pipelineModelConstraintHash,
          orchAddress: orchestratorAddress ?? null,
          advertisedPriceWeiPerUnit: signedPriceStr,
          advertisedPixelsPerUnit: signedPixelsStr,
          signedPriceWeiPerUnit: pricePerUnit.toString(),
          signedPixelsPerUnit: pixelsPerUnit.toString(),
          networkFeeWei: feeWei.toString(),
          networkFeeUsdMicros: networkFeeUsdMicros.toString(),
          platformFeeWei: platformCutWei.toString(),
          platformFeeUsdMicros: ownerPlatformFeeUsdMicros.toString(),
          ownerChargeWei: ownerChargeWei.toString(),
          ownerChargeUsdMicros: ownerChargeUsdMicros.toString(),
          upchargePercentBps: upchargeResult.bps,
          pricingRuleSource: upchargeResult.source,
          endUserBillableUsdMicros: endUserBillableUsdMicros.toString(),
          ethUsdPrice: ethUsd.priceUsd.toString(),
          ethUsdSource: ethUsd.source,
          ethUsdObservedAt: ethUsd.observedAt,
          createdAt: new Date().toISOString(),
        });
      }
    }
  });
}
