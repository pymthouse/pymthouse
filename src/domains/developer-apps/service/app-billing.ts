import { calendarMonthBoundsUtc, dateKeysInclusiveUtc } from "@/shared/utils/billing-utils";
import { weiToEthString } from "@/domains/usage-billing/service/billing-runtime";

function dateKeyFromIso(iso: string): string {
  return iso.slice(0, 10);
}

export function resolveBillingPeriod(params: {
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  now: Date;
}) {
  if (params.currentPeriodStart && params.currentPeriodEnd) {
    return {
      periodStart: params.currentPeriodStart,
      periodEnd: params.currentPeriodEnd,
    };
  }

  const calendar = calendarMonthBoundsUtc(params.now);
  return {
    periodStart: calendar.start,
    periodEnd: calendar.end,
  };
}

export function buildBillingCycleSummary(params: {
  usageRows: Array<{
    id: string;
    createdAt: string;
    fee: string;
    units: string;
  }>;
  billingEvents: Array<{
    pipeline: string;
    modelId: string;
    networkFeeWei: string;
    networkFeeUsdMicros: string;
    platformFeeUsdMicros: string;
    ownerChargeWei: string;
    ownerChargeUsdMicros: string;
    endUserBillableUsdMicros: string;
  }>;
  periodStart: string;
  periodEnd: string;
  plan: {
    type: string | null;
    includedUnits: string | null;
    overageRateWei: string | null;
    includedUsdMicros: string | null;
  } | null;
}) {
  let totalFeeWei = 0n;
  let totalUnits = 0n;
  const byDay = new Map<string, { requestCount: number; feeWei: bigint }>();

  for (const row of params.usageRows) {
    const feeWei = BigInt(row.fee || "0");
    totalFeeWei += feeWei;
    totalUnits += BigInt(row.units || "0");
    const day = dateKeyFromIso(row.createdAt);
    const bucket = byDay.get(day) || { requestCount: 0, feeWei: 0n };
    bucket.requestCount += 1;
    bucket.feeWei += feeWei;
    byDay.set(day, bucket);
  }

  let totalNetworkFeeWei = 0n;
  let totalNetworkFeeUsdMicros = 0n;
  let totalPlatformFeeUsdMicros = 0n;
  let totalOwnerChargeWei = 0n;
  let totalOwnerChargeUsdMicros = 0n;
  let totalEndUserBillableUsdMicros = 0n;

  const byPipelineModel = new Map<string, {
    pipeline: string;
    modelId: string;
    networkFeeWei: bigint;
    networkFeeUsdMicros: bigint;
    ownerChargeUsdMicros: bigint;
    endUserBillableUsdMicros: bigint;
    count: number;
  }>();

  for (const event of params.billingEvents) {
    totalNetworkFeeWei += BigInt(event.networkFeeWei);
    totalNetworkFeeUsdMicros += BigInt(event.networkFeeUsdMicros);
    totalPlatformFeeUsdMicros += BigInt(event.platformFeeUsdMicros);
    totalOwnerChargeWei += BigInt(event.ownerChargeWei);
    totalOwnerChargeUsdMicros += BigInt(event.ownerChargeUsdMicros);
    totalEndUserBillableUsdMicros += BigInt(event.endUserBillableUsdMicros);

    const key = `${event.pipeline}|${event.modelId}`;
    const existing = byPipelineModel.get(key) || {
      pipeline: event.pipeline,
      modelId: event.modelId,
      networkFeeWei: 0n,
      networkFeeUsdMicros: 0n,
      ownerChargeUsdMicros: 0n,
      endUserBillableUsdMicros: 0n,
      count: 0,
    };
    existing.networkFeeWei += BigInt(event.networkFeeWei);
    existing.networkFeeUsdMicros += BigInt(event.networkFeeUsdMicros);
    existing.ownerChargeUsdMicros += BigInt(event.ownerChargeUsdMicros);
    existing.endUserBillableUsdMicros += BigInt(event.endUserBillableUsdMicros);
    existing.count += 1;
    byPipelineModel.set(key, existing);
  }

  const timeline = dateKeysInclusiveUtc(params.periodStart, params.periodEnd).map((date) => {
    const bucket = byDay.get(date);
    return {
      date,
      requestCount: bucket?.requestCount ?? 0,
      feeWei: (bucket?.feeWei ?? 0n).toString(),
    };
  });

  const planType = params.plan?.type ?? "free";
  let overageUnits = "0";
  let overageWei = "0";
  if (
    (planType === "subscription" || planType === "usage") &&
    params.plan?.includedUnits != null &&
    params.plan?.overageRateWei != null
  ) {
    const included = BigInt(params.plan.includedUnits);
    const rate = BigInt(params.plan.overageRateWei);
    if (totalUnits > included) {
      const over = totalUnits - included;
      overageUnits = over.toString();
      overageWei = (over * rate).toString();
    }
  }

  const includedUsdMicros = params.plan?.includedUsdMicros
    ? BigInt(params.plan.includedUsdMicros)
    : 0n;
  const consumedUsdMicros =
    totalEndUserBillableUsdMicros < includedUsdMicros
      ? totalEndUserBillableUsdMicros
      : includedUsdMicros;
  const remainingUsdMicros =
    includedUsdMicros > consumedUsdMicros
      ? includedUsdMicros - consumedUsdMicros
      : 0n;

  return {
    usage: {
      requestCount: params.usageRows.length,
      totalFeeWei: totalFeeWei.toString(),
      totalFeeEth: weiToEthString(totalFeeWei),
      totalUnits: totalUnits.toString(),
    },
    timeline,
    overage: { overageUnits, overageWei },
    ownerCost: {
      networkFeeWei: totalNetworkFeeWei.toString(),
      networkFeeEth: weiToEthString(totalNetworkFeeWei),
      networkFeeUsdMicros: totalNetworkFeeUsdMicros.toString(),
      platformFeeUsdMicros: totalPlatformFeeUsdMicros.toString(),
      ownerChargeWei: totalOwnerChargeWei.toString(),
      ownerChargeEth: weiToEthString(totalOwnerChargeWei),
      ownerChargeUsdMicros: totalOwnerChargeUsdMicros.toString(),
    },
    retail: {
      endUserBillableUsdMicros: totalEndUserBillableUsdMicros.toString(),
      includedUsdMicros: includedUsdMicros.toString(),
      consumedIncludedUsdMicros: consumedUsdMicros.toString(),
      remainingIncludedUsdMicros: remainingUsdMicros.toString(),
    },
    byPipelineModel: [...byPipelineModel.values()].map((entry) => ({
      pipeline: entry.pipeline,
      modelId: entry.modelId,
      requestCount: entry.count,
      networkFeeWei: entry.networkFeeWei.toString(),
      networkFeeEth: weiToEthString(entry.networkFeeWei),
      networkFeeUsdMicros: entry.networkFeeUsdMicros.toString(),
      ownerChargeUsdMicros: entry.ownerChargeUsdMicros.toString(),
      endUserBillableUsdMicros: entry.endUserBillableUsdMicros.toString(),
    })),
  };
}
