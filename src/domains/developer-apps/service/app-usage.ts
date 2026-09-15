import { weiToEthString } from "@/domains/usage-billing/service/billing-runtime";

export type UsageGroupBy = "none" | "user" | "pipeline_model";

type Ok<T> = { ok: true; value: T };
type Err = { ok: false; status: 400; body: { error: string } };

export interface ParsedUsageQuery {
  startDate: string | null;
  endDate: string | null;
  groupBy: UsageGroupBy;
  filterUserId: string | null;
  filterGatewayRequestId: string | null;
}

export function parseUsageQuery(url: URL): Ok<ParsedUsageQuery> | Err {
  const startDate = url.searchParams.get("startDate");
  const endDate = url.searchParams.get("endDate");
  const rawGroupBy = url.searchParams.get("groupBy") || "none";
  const groupBy: UsageGroupBy =
    rawGroupBy === "user" || rawGroupBy === "pipeline_model" ? rawGroupBy : "none";

  if (startDate && Number.isNaN(Date.parse(startDate))) {
    return { ok: false, status: 400, body: { error: "Invalid startDate format" } };
  }
  if (endDate && Number.isNaN(Date.parse(endDate))) {
    return { ok: false, status: 400, body: { error: "Invalid endDate format" } };
  }

  return {
    ok: true,
    value: {
      startDate,
      endDate,
      groupBy,
      filterUserId: url.searchParams.get("userId"),
      filterGatewayRequestId: url.searchParams.get("gatewayRequestId"),
    },
  };
}

export function buildUsageTotals(params: {
  usageRows: Array<{ id: string; fee: string }>;
  eventByUsageRecord: Map<string | null, {
    networkFeeUsdMicros: string;
    ownerChargeWei: string;
    ownerChargeUsdMicros: string;
    platformFeeWei: string;
    endUserBillableUsdMicros: string;
  }>;
}) {
  let totalFeeWei = 0n;
  let totalNetworkFeeUsdMicros = 0n;
  let totalOwnerChargeWei = 0n;
  let totalOwnerChargeUsdMicros = 0n;
  let totalPlatformFeeWei = 0n;
  let totalEndUserBillableUsdMicros = 0n;

  for (const row of params.usageRows) {
    totalFeeWei += BigInt(row.fee);
    const event = params.eventByUsageRecord.get(row.id);
    if (event) {
      totalNetworkFeeUsdMicros += BigInt(event.networkFeeUsdMicros);
      totalOwnerChargeWei += BigInt(event.ownerChargeWei);
      totalOwnerChargeUsdMicros += BigInt(event.ownerChargeUsdMicros);
      totalPlatformFeeWei += BigInt(event.platformFeeWei);
      totalEndUserBillableUsdMicros += BigInt(event.endUserBillableUsdMicros);
    }
  }

  return {
    requestCount: params.usageRows.length,
    totalFeeWei: totalFeeWei.toString(),
    totalFeeEth: weiToEthString(totalFeeWei),
    networkFeeUsdMicros: totalNetworkFeeUsdMicros.toString(),
    ownerChargeWei: totalOwnerChargeWei.toString(),
    ownerChargeEth: weiToEthString(totalOwnerChargeWei),
    ownerChargeUsdMicros: totalOwnerChargeUsdMicros.toString(),
    platformFeeWei: totalPlatformFeeWei.toString(),
    platformFeeEth: weiToEthString(totalPlatformFeeWei),
    endUserBillableUsdMicros: totalEndUserBillableUsdMicros.toString(),
  };
}
