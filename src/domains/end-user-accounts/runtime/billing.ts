import { weiToEthString } from "@/domains/usage-billing/service/billing-runtime";
import { listTransactions } from "../repo/transactions";

export async function getBillingTransactions(params: {
  endUserId?: string;
  limit: number;
  offset: number;
}) {
  const transactions = await listTransactions(params);
  return transactions.map((tx) => ({
    ...tx,
    amountEth: weiToEthString(BigInt(tx.amountWei)),
    ownerChargeEth: tx.ownerChargeWei ? weiToEthString(BigInt(tx.ownerChargeWei)) : null,
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
}
