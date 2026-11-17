import { v4 as uuidv4 } from "uuid";
import type { AuthResult } from "@/domains/identity-access/runtime/request-auth";
import {
  buildSignedTicketConstraintHash,
  computeUsdMicrosFromWei,
  resolveGatewayAttribution,
  resolvePaymentPipelineModelConstraint,
  resolveUpcharge,
} from "@/domains/usage-billing/service/billing-runtime";
import {
  calculateFeeWei,
  calculateLv2vPixels,
  calculatePlatformCut,
  decodeOrchestratorInfo,
} from "@/platform/livepeer/proto";
import { getEthUsdOracle } from "@/platform/ops/prices/eth-usd-oracle";
import {
  createStreamSession,
  findExistingUsageRecord,
  getActiveStreamSessionByManifestId,
  getLatestActivePlanWithBundles,
  recordSignerPaymentLedger,
} from "../repo/signer-payments";
import { readSignerAppApproval, resolveUsageUserIdentifier } from "../repo/signer-routing";
import { parseSignerPaymentRequest } from "../service/signer-payment";
import { forwardToSigner, readSignerUpstreamBody, type ProxyResult } from "./signer-forwarding";
import { getSignerRoutingContext } from "./signer-routing";

export async function assertSignerAppApproved(auth: AuthResult) {
  if (!auth.appId?.trim()) {
    return { ok: true as const };
  }

  const app = await readSignerAppApproval(auth.appId);
  if (app && app.status !== "approved") {
    if (auth.userId !== app.ownerId) {
      return {
        ok: false as const,
        status: 403,
        body: {
          error: "app_not_approved",
          error_description:
            "This application has not been approved and cannot process live payments",
        },
      };
    }

    console.warn(
      `[api] generate-live-payment: unapproved app ${app.id} accessed by owner ${auth.userId} (status: ${app.status})`,
    );
  }

  return { ok: true as const };
}

export async function proxyGenerateLivePayment(
  requestBody: Record<string, unknown>,
  auth: AuthResult,
): Promise<ProxyResult> {
  const { signer, providerAppId } = await getSignerRoutingContext(auth.appId);
  if (!signer || signer.status !== "running") {
    return { status: 503, body: { error: "Signer is not running" } };
  }

  const parsed = parseSignerPaymentRequest(requestBody);
  if (!parsed.ok) {
    return { status: 400, body: { error: parsed.message } };
  }

  const {
    manifestId,
    inPixels,
    preloadSeconds,
    jobType,
    orchestratorData,
  } = parsed.value;
  const normalizedJobType = jobType?.trim().toLowerCase();

  let pricePerUnit = 0n;
  let pixelsPerUnit = 1n;
  let orchestratorAddress: string | undefined;

  if (orchestratorData) {
    try {
      const orchInfo = await decodeOrchestratorInfo(orchestratorData);
      if (orchInfo.priceInfo) {
        pricePerUnit = BigInt(orchInfo.priceInfo.pricePerUnit);
        pixelsPerUnit = BigInt(orchInfo.priceInfo.pixelsPerUnit || 1);
      }
      if (orchInfo.address) {
        orchestratorAddress = `0x${Buffer.from(orchInfo.address).toString("hex")}`;
      }
    } catch (err) {
      console.warn("[proxy] Failed to decode OrchestratorInfo:", err);
    }
  }

  let pixels: bigint;
  if (inPixels && inPixels > 0) {
    pixels = BigInt(inPixels);
  } else if (normalizedJobType === "lv2v") {
    pixels = calculateLv2vPixels(1);
  } else if (normalizedJobType === "byoc" && preloadSeconds && preloadSeconds > 0) {
    pixels = BigInt(Math.ceil(preloadSeconds));
  } else {
    pixels = 0n;
  }

  const feeWei = calculateFeeWei(pixels, pricePerUnit, pixelsPerUnit);
  const platformCutWei = calculatePlatformCut(feeWei, signer.defaultCutPercent);
  const usageUserId = await resolveUsageUserIdentifier({ auth, providerAppId });
  const nowIso = new Date().toISOString();
  let streamSessionId: string | null = null;

  if (manifestId) {
    const existingSession = await getActiveStreamSessionByManifestId(manifestId);
    if (existingSession) {
      streamSessionId = existingSession.id;
    } else {
      streamSessionId = uuidv4();
      await createStreamSession({
        id: streamSessionId,
        endUserId: auth.endUserId || null,
        appId: providerAppId ?? auth.appId ?? null,
        bearerTokenHash: auth.tokenHash,
        manifestId,
        orchestratorAddress,
        signerPaymentCount: 0,
        totalFeeWei: "0",
        pricePerUnit: pricePerUnit.toString(),
        pixelsPerUnit: pixelsPerUnit.toString(),
        status: "active",
        lastPaymentAt: null,
      });
    }
  }

  const constraint = await resolvePaymentPipelineModelConstraint(requestBody);
  const attribution = resolveGatewayAttribution(requestBody);

  try {
    const result = await forwardToSigner({
      signer,
      path: "/generate-live-payment",
      method: "POST",
      body: requestBody,
      auth,
    });
    const responseBody = await readSignerUpstreamBody(result.response);

    if (result.response.ok) {
      const orchAddrForConstraint =
        orchestratorAddress && orchestratorAddress.length > 0 ? orchestratorAddress : "0x";
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

      const priceValidationStatus = constraint ? "matched" : "missing_constraint";
      const priceValidationReason = constraint
        ? undefined
        : "No pipeline/model in request (add pipeline and modelId or capabilities with PerCapability models) for full attribution.";

      const rawReq =
        (typeof requestBody.requestId === "string" && requestBody.requestId.trim()) ||
        (typeof requestBody.RequestID === "string" && requestBody.RequestID.trim());
      const requestId = rawReq || uuidv4();

      const existingUsage =
        providerAppId ? await findExistingUsageRecord({ clientId: providerAppId, requestId }) : null;

      if (!existingUsage) {
        const ethUsd = await getEthUsdOracle();
        const networkFeeUsdMicros = computeUsdMicrosFromWei(feeWei, ethUsd.priceUsd);
        const ownerChargeWei = feeWei + platformCutWei;
        const ownerPlatformFeeUsdMicros = computeUsdMicrosFromWei(platformCutWei, ethUsd.priceUsd);
        const ownerChargeUsdMicros = computeUsdMicrosFromWei(ownerChargeWei, ethUsd.priceUsd);

        let upchargeResult: {
          bps: number;
          source: "pipeline_model" | "general" | "pay_per_use" | "subscription_included" | "unpriced";
        } = { bps: 0, source: "unpriced" };
        if (providerAppId && constraint) {
          try {
            const planState = await getLatestActivePlanWithBundles(providerAppId);
            upchargeResult = resolveUpcharge({
              plan: planState.plan,
              bundles: planState.bundles,
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

        await recordSignerPaymentLedger({
          streamSessionId,
          feeWei,
          nowIso,
          pricePerUnit,
          pixelsPerUnit,
          transaction: {
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
          },
          usageRecord: providerAppId
            ? {
                id: usageRecordId,
                requestId,
                userId: usageUserId,
                clientId: providerAppId,
                modelId: constraint?.modelId ?? null,
                units: pixels.toString(),
                fee: feeWei.toString(),
                createdAt: new Date().toISOString(),
              }
            : undefined,
          usageBillingEvent:
            providerAppId && constraint && pipelineModelConstraintHash
              ? {
                  id: uuidv4(),
                  usageRecordId,
                  transactionId,
                  streamSessionId,
                  clientId: providerAppId,
                  userId: usageUserId,
                  pipeline: constraint.pipeline,
                  modelId: constraint.modelId,
                  attributionSource: attribution.attributionSource,
                  gatewayRequestId: attribution.gatewayRequestId,
                  paymentMetadataVersion: attribution.paymentMetadataVersion,
                  pipelineModelConstraintHash,
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
                }
              : undefined,
        });
      }
    }

    return { status: result.response.status, body: responseBody };
  } catch (error) {
    console.error("[proxy] Failed to forward generate-live-payment:", error);
    return { status: 502, body: { error: "Failed to reach signer" } };
  }
}
