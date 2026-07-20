import { NextResponse } from "next/server";
import { withAdminGuard } from "@/lib/api-guards";
import { getTransactions } from "@/lib/billing";
import { weiToEthString } from "@/lib/billing-runtime";

export const GET = withAdminGuard(async (request) => {
  const url = new URL(request.url);
  const endUserId = url.searchParams.get("endUserId");
  const limit = Number.parseInt(url.searchParams.get("limit") || "50");
  const offset = Number.parseInt(url.searchParams.get("offset") || "0");

  const recentTransactions = await getTransactions(
    endUserId || undefined,
    limit,
    offset,
  );

  const enriched = recentTransactions.map((tx) => ({
    ...tx,
    // ETH convenience fields derived from stored wei
    amountEth: weiToEthString(BigInt(tx.amountWei)),
    ownerChargeEth: tx.ownerChargeWei ? weiToEthString(BigInt(tx.ownerChargeWei)) : null,
    // Expose validated pipeline/model and gateway attribution
    pipeline: tx.pipeline ?? null,
    modelId: tx.modelId ?? null,
    attributionSource: tx.attributionSource ?? null,
    gatewayRequestId: tx.gatewayRequestId ?? null,
    paymentMetadataVersion: tx.paymentMetadataVersion ?? null,
    pipelineModelConstraintHash: tx.pipelineModelConstraintHash ?? null,
    priceValidationStatus: tx.priceValidationStatus ?? null,
    advertisedPriceWeiPerUnit: tx.advertisedPriceWeiPerUnit ?? null,
    signedPriceWeiPerUnit: tx.signedPriceWeiPerUnit ?? null,
    ethUsdPrice: tx.ethUsdPrice ?? null,
    ethUsdSource: tx.ethUsdSource ?? null,
    ethUsdObservedAt: tx.ethUsdObservedAt ?? null,
    networkFeeUsdMicros: tx.networkFeeUsdMicros ?? null,
    ownerChargeUsdMicros: tx.ownerChargeUsdMicros ?? null,
  }));

  return NextResponse.json({
    transactions: enriched,
    pagination: { limit, offset, hasMore: recentTransactions.length === limit },
  });
});
