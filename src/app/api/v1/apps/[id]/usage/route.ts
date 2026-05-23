import { NextRequest, NextResponse } from "next/server";
import { authenticateAppClient } from "@/lib/auth";
import { db } from "@/db/index";
import {
  appUsers,
  endUsers,
  usageBillingEvents,
  usageRecords,
} from "@/db/schema";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { getAuthorizedProviderApp, getProviderApp } from "@/lib/provider-apps";

type UsageUserType = "system_managed" | "oidc_authorized" | "unknown";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const clientAuth = await authenticateAppClient(request);

  let app: Awaited<ReturnType<typeof getProviderApp>> | null = null;
  if (clientAuth?.appId === clientId) {
    app = await getProviderApp(clientId);
  } else {
    let providerAuth: Awaited<ReturnType<typeof getAuthorizedProviderApp>> | null = null;
    try {
      providerAuth = await getAuthorizedProviderApp(clientId);
    } catch {
      providerAuth = null;
    }
    if (!providerAuth) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    app = providerAuth.app;
  }

  if (!app) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const url = new URL(request.url);
  const startDate = url.searchParams.get("startDate");
  const endDate = url.searchParams.get("endDate");
  const groupBy = url.searchParams.get("groupBy") || "none";
  const filterUserId = url.searchParams.get("userId");
  const filterGatewayRequestId = url.searchParams.get("gatewayRequestId");

  if (startDate && isNaN(Date.parse(startDate))) {
    return NextResponse.json({ error: "Invalid startDate format" }, { status: 400 });
  }
  if (endDate && isNaN(Date.parse(endDate))) {
    return NextResponse.json({ error: "Invalid endDate format" }, { status: 400 });
  }

  const conditions = [eq(usageRecords.clientId, app.id)];
  if (startDate) conditions.push(gte(usageRecords.createdAt, startDate));
  if (endDate) conditions.push(lte(usageRecords.createdAt, endDate));
  if (filterUserId) conditions.push(eq(usageRecords.userId, filterUserId));

  const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions);

  let rows = await db
    .select()
    .from(usageRecords)
    .where(whereClause!);

  // Fetch billing events joined to these usage records
  const usageRecordIds = rows.map((r) => r.id).filter(Boolean);
  const billingEvents =
    usageRecordIds.length > 0
      ? await db
          .select()
          .from(usageBillingEvents)
          .where(
            and(
              eq(usageBillingEvents.clientId, app.id),
              filterGatewayRequestId
                ? eq(usageBillingEvents.gatewayRequestId, filterGatewayRequestId)
                : undefined,
              inArray(usageBillingEvents.usageRecordId, usageRecordIds),
            ),
          )
      : [];

  if (filterGatewayRequestId) {
    const allowedUsageIds = new Set(
      billingEvents
        .map((e) => e.usageRecordId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    );
    rows = rows.filter((r) => allowedUsageIds.has(r.id));
  }

  // Build a map from usageRecordId → billing event for quick join
  const eventByUsageRecord = new Map(
    billingEvents.map((e) => [e.usageRecordId, e]),
  );

  let totalNetworkFeeUsdMicros = 0n;
  let totalOwnerChargeUsdMicros = 0n;
  let totalPlatformFeeUsdMicros = 0n;
  let totalEndUserBillableUsdMicros = 0n;
  const usageCurrency = "USD";

  for (const row of rows) {
    const event = eventByUsageRecord.get(row.id);
    if (event) {
      totalNetworkFeeUsdMicros += BigInt(event.networkFeeUsdMicros);
      totalOwnerChargeUsdMicros += BigInt(event.ownerChargeUsdMicros);
      totalPlatformFeeUsdMicros += BigInt(event.platformFeeUsdMicros);
      totalEndUserBillableUsdMicros += BigInt(event.endUserBillableUsdMicros);
    }
  }

  const totals = {
    requestCount: rows.length,
    currency: usageCurrency,
    networkFeeUsdMicros: totalNetworkFeeUsdMicros.toString(),
    ownerChargeUsdMicros: totalOwnerChargeUsdMicros.toString(),
    platformFeeUsdMicros: totalPlatformFeeUsdMicros.toString(),
    endUserBillableUsdMicros: totalEndUserBillableUsdMicros.toString(),
  };

  const response: Record<string, unknown> = {
    clientId,
    period: { start: startDate || null, end: endDate || null },
    totals,
  };

  if (groupBy === "user") {
    const byUserMap = new Map<
      string,
      {
        networkFeeUsdMicros: bigint;
        ownerChargeUsdMicros: bigint;
        endUserBillableUsdMicros: bigint;
        count: number;
      }
    >();
    for (const row of rows) {
      const uid = row.userId || "unknown";
      const existing = byUserMap.get(uid) || {
        networkFeeUsdMicros: 0n,
        ownerChargeUsdMicros: 0n,
        endUserBillableUsdMicros: 0n,
        count: 0,
      };
      existing.count += 1;
      const event = eventByUsageRecord.get(row.id);
      if (event) {
        existing.networkFeeUsdMicros += BigInt(event.networkFeeUsdMicros);
        existing.ownerChargeUsdMicros += BigInt(event.ownerChargeUsdMicros);
        existing.endUserBillableUsdMicros += BigInt(event.endUserBillableUsdMicros);
      }
      byUserMap.set(uid, existing);
    }

    const userIds = [...byUserMap.keys()].filter((k) => k !== "unknown");
    const appUserRows = userIds.length > 0
      ? await db.select().from(appUsers).where(inArray(appUsers.id, userIds))
      : [];
    const appUserMap = new Map(appUserRows.map((u) => [u.id, u]));
    const appUserRowsByExternal = userIds.length > 0
      ? await db.select().from(appUsers).where(inArray(appUsers.externalUserId, userIds))
      : [];
    const appUserExternalMap = new Map(appUserRowsByExternal.map((u) => [u.externalUserId, u]));

    const endUserRows =
      userIds.length > 0
        ? await db
            .select({ id: endUsers.id, externalUserId: endUsers.externalUserId })
            .from(endUsers)
            .where(and(eq(endUsers.appId, app.id), inArray(endUsers.id, userIds)))
        : [];
    const endUserMap = new Map(endUserRows.map((u) => [u.id, u]));
    const endUserRowsByExternal =
      userIds.length > 0
        ? await db
            .select({ id: endUsers.id, externalUserId: endUsers.externalUserId })
            .from(endUsers)
            .where(and(eq(endUsers.appId, app.id), inArray(endUsers.externalUserId, userIds)))
        : [];
    const endUserExternalMap = new Map(endUserRowsByExternal.map((u) => [u.externalUserId, u]));

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
        currency: usageCurrency,
        networkFeeUsdMicros: data.networkFeeUsdMicros.toString(),
        ownerChargeUsdMicros: data.ownerChargeUsdMicros.toString(),
        endUserBillableUsdMicros: data.endUserBillableUsdMicros.toString(),
        requestCount: data.count,
      };
    });
  }

  if (groupBy === "pipeline_model") {
    const byKeyMap = new Map<string, {
      pipeline: string;
      modelId: string;
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
        networkFeeUsdMicros: 0n,
        ownerChargeUsdMicros: 0n,
        endUserBillableUsdMicros: 0n,
        count: 0,
      };
      existing.networkFeeUsdMicros += BigInt(event.networkFeeUsdMicros);
      existing.ownerChargeUsdMicros += BigInt(event.ownerChargeUsdMicros);
      existing.endUserBillableUsdMicros += BigInt(event.endUserBillableUsdMicros);
      existing.count += 1;
      byKeyMap.set(key, existing);
    }

    response.byPipelineModel = [...byKeyMap.values()].map((data) => ({
      pipeline: data.pipeline,
      modelId: data.modelId,
      currency: usageCurrency,
      requestCount: data.count,
      networkFeeUsdMicros: data.networkFeeUsdMicros.toString(),
      ownerChargeUsdMicros: data.ownerChargeUsdMicros.toString(),
      endUserBillableUsdMicros: data.endUserBillableUsdMicros.toString(),
    }));
  }

  // Per-record detail when gatewayRequestId filter is provided
  if (filterGatewayRequestId) {
    response.events = billingEvents.map((e) => ({
      id: e.id,
      usageRecordId: e.usageRecordId,
      pipeline: e.pipeline,
      modelId: e.modelId,
      attributionSource: e.attributionSource,
      gatewayRequestId: e.gatewayRequestId,
      paymentMetadataVersion: e.paymentMetadataVersion,
      pipelineModelConstraintHash: e.pipelineModelConstraintHash,
      orchAddress: e.orchAddress,
      currency: usageCurrency,
      networkFeeUsdMicros: e.networkFeeUsdMicros,
      platformFeeUsdMicros: e.platformFeeUsdMicros,
      ownerChargeUsdMicros: e.ownerChargeUsdMicros,
      upchargePercentBps: e.upchargePercentBps,
      pricingRuleSource: e.pricingRuleSource,
      endUserBillableUsdMicros: e.endUserBillableUsdMicros,
      createdAt: e.createdAt,
    }));
  }

  return NextResponse.json(response);
}
