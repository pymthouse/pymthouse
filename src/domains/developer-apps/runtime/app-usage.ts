import type { NextRequest } from "next/server";
import { weiToEthString } from "@/domains/usage-billing/service/billing-runtime";
import { getProviderAppForClientOrDashboard } from "./app-access";
import {
  listAppUsersByExternalIds,
  listAppUsersByIds,
  listEndUsersByExternalIds,
  listEndUsersByIds,
  listUsageBillingEvents,
  listUsageRecords,
} from "../repo/app-usage";
import { buildUsageTotals, parseUsageQuery } from "../service/app-usage";

type UsageUserType = "system_managed" | "oidc_authorized" | "unknown";

export async function readAppUsage(
  request: NextRequest,
  clientId: string,
): Promise<
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: 400 | 404; body: { error: string } }
> {
  const app = await getProviderAppForClientOrDashboard(request, clientId);
  if (!app) {
    return { ok: false, status: 404, body: { error: "Not found" } };
  }

  const parsed = parseUsageQuery(new URL(request.url));
  if (!parsed.ok) {
    return parsed;
  }

  let rows = await listUsageRecords({
    appId: app.id,
    startDate: parsed.value.startDate,
    endDate: parsed.value.endDate,
    filterUserId: parsed.value.filterUserId,
  });

  const billingEvents = await listUsageBillingEvents({
    appId: app.id,
    usageRecordIds: rows.map((row) => row.id).filter(Boolean),
    gatewayRequestId: parsed.value.filterGatewayRequestId,
  });

  if (parsed.value.filterGatewayRequestId) {
    const allowedUsageIds = new Set(
      billingEvents
        .map((event) => event.usageRecordId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    );
    rows = rows.filter((row) => allowedUsageIds.has(row.id));
  }

  const eventByUsageRecord = new Map(billingEvents.map((event) => [event.usageRecordId, event]));
  const response: Record<string, unknown> = {
    clientId,
    period: { start: parsed.value.startDate, end: parsed.value.endDate },
    totals: buildUsageTotals({
      usageRows: rows.map((row) => ({ id: row.id, fee: row.fee })),
      eventByUsageRecord,
    }),
  };

  if (parsed.value.groupBy === "user") {
    const byUserMap = new Map<string, {
      feeWei: bigint;
      networkFeeUsdMicros: bigint;
      endUserBillableUsdMicros: bigint;
      count: number;
    }>();

    for (const row of rows) {
      const userId = row.userId || "unknown";
      const existing = byUserMap.get(userId) || {
        feeWei: 0n,
        networkFeeUsdMicros: 0n,
        endUserBillableUsdMicros: 0n,
        count: 0,
      };
      existing.feeWei += BigInt(row.fee);
      existing.count += 1;
      const event = eventByUsageRecord.get(row.id);
      if (event) {
        existing.networkFeeUsdMicros += BigInt(event.networkFeeUsdMicros);
        existing.endUserBillableUsdMicros += BigInt(event.endUserBillableUsdMicros);
      }
      byUserMap.set(userId, existing);
    }

    const userIds = [...byUserMap.keys()].filter((key) => key !== "unknown");
    const appUserMap = new Map((await listAppUsersByIds(userIds)).map((u) => [u.id, u]));
    const appUserExternalMap = new Map(
      (await listAppUsersByExternalIds(userIds)).map((u) => [u.externalUserId, u]),
    );
    const endUserMap = new Map((await listEndUsersByIds(app.id, userIds)).map((u) => [u.id, u]));
    const endUserExternalMap = new Map(
      (await listEndUsersByExternalIds(app.id, userIds)).map((u) => [u.externalUserId, u]),
    );

    response.byUser = [...byUserMap.entries()].map(([endUserId, data]) => {
      const externalUserId =
        appUserMap.get(endUserId)?.externalUserId ??
        appUserExternalMap.get(endUserId)?.externalUserId ??
        endUserMap.get(endUserId)?.externalUserId ??
        endUserExternalMap.get(endUserId)?.externalUserId ??
        null;
      let userType: UsageUserType = "unknown";
      if (externalUserId) userType = "system_managed";
      else if (endUserId !== "unknown") userType = "oidc_authorized";

      return {
        endUserId,
        externalUserId,
        userType,
        identifier: endUserId,
        feeWei: data.feeWei.toString(),
        feeEth: weiToEthString(data.feeWei),
        networkFeeUsdMicros: data.networkFeeUsdMicros.toString(),
        endUserBillableUsdMicros: data.endUserBillableUsdMicros.toString(),
        requestCount: data.count,
      };
    });
  }

  if (parsed.value.groupBy === "pipeline_model") {
    const byKeyMap = new Map<string, {
      pipeline: string;
      modelId: string;
      feeWei: bigint;
      networkFeeUsdMicros: bigint;
      ownerChargeUsdMicros: bigint;
      endUserBillableUsdMicros: bigint;
      count: number;
    }>();

    for (const event of billingEvents) {
      const key = `${event.pipeline}|${event.modelId}`;
      const existing = byKeyMap.get(key) || {
        pipeline: event.pipeline,
        modelId: event.modelId,
        feeWei: 0n,
        networkFeeUsdMicros: 0n,
        ownerChargeUsdMicros: 0n,
        endUserBillableUsdMicros: 0n,
        count: 0,
      };
      existing.feeWei += BigInt(event.networkFeeWei);
      existing.networkFeeUsdMicros += BigInt(event.networkFeeUsdMicros);
      existing.ownerChargeUsdMicros += BigInt(event.ownerChargeUsdMicros);
      existing.endUserBillableUsdMicros += BigInt(event.endUserBillableUsdMicros);
      existing.count += 1;
      byKeyMap.set(key, existing);
    }

    response.byPipelineModel = [...byKeyMap.values()].map((data) => ({
      pipeline: data.pipeline,
      modelId: data.modelId,
      requestCount: data.count,
      networkFeeWei: data.feeWei.toString(),
      networkFeeEth: weiToEthString(data.feeWei),
      networkFeeUsdMicros: data.networkFeeUsdMicros.toString(),
      ownerChargeUsdMicros: data.ownerChargeUsdMicros.toString(),
      endUserBillableUsdMicros: data.endUserBillableUsdMicros.toString(),
    }));
  }

  if (parsed.value.filterGatewayRequestId) {
    response.events = billingEvents.map((event) => ({
      id: event.id,
      usageRecordId: event.usageRecordId,
      pipeline: event.pipeline,
      modelId: event.modelId,
      attributionSource: event.attributionSource,
      gatewayRequestId: event.gatewayRequestId,
      paymentMetadataVersion: event.paymentMetadataVersion,
      pipelineModelConstraintHash: event.pipelineModelConstraintHash,
      orchAddress: event.orchAddress,
      advertisedPriceWeiPerUnit: event.advertisedPriceWeiPerUnit,
      advertisedPixelsPerUnit: event.advertisedPixelsPerUnit,
      signedPriceWeiPerUnit: event.signedPriceWeiPerUnit,
      signedPixelsPerUnit: event.signedPixelsPerUnit,
      networkFeeWei: event.networkFeeWei,
      networkFeeEth: weiToEthString(BigInt(event.networkFeeWei)),
      networkFeeUsdMicros: event.networkFeeUsdMicros,
      platformFeeWei: event.platformFeeWei,
      platformFeeEth: weiToEthString(BigInt(event.platformFeeWei)),
      platformFeeUsdMicros: event.platformFeeUsdMicros,
      ownerChargeWei: event.ownerChargeWei,
      ownerChargeEth: weiToEthString(BigInt(event.ownerChargeWei)),
      ownerChargeUsdMicros: event.ownerChargeUsdMicros,
      upchargePercentBps: event.upchargePercentBps,
      pricingRuleSource: event.pricingRuleSource,
      endUserBillableUsdMicros: event.endUserBillableUsdMicros,
      ethUsdPrice: event.ethUsdPrice,
      ethUsdSource: event.ethUsdSource,
      ethUsdObservedAt: event.ethUsdObservedAt,
      createdAt: event.createdAt,
    }));
  }

  return { ok: true, body: response };
}
