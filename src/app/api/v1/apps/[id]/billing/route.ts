import { NextRequest, NextResponse } from "next/server";
import { authenticateAppClient } from "@/lib/auth";
import { db } from "@/db/index";
import { plans, signerConfig, subscriptions, usageBillingEvents, usageRecords } from "@/db/schema";
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { getAuthorizedProviderApp, getProviderApp } from "@/lib/provider-apps";
import { calendarMonthBoundsUtc, dateKeysInclusiveUtc } from "@/lib/billing-utils";
import { weiToEthString } from "@/lib/billing-runtime";

function dateKeyFromIso(iso: string): string {
  return iso.slice(0, 10);
}

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
    } catch (err) {
      // Log error for debugging
      console.error("getAuthorizedProviderApp failed", err);
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

  const signerRows = await db
    .select({ defaultCutPercent: signerConfig.defaultCutPercent })
    .from(signerConfig)
    .where(eq(signerConfig.id, "default"))
    .limit(1);
  const platformCutPercent = signerRows[0]?.defaultCutPercent ?? null;

  const ownerSubRows = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.clientId, app.id),
        eq(subscriptions.userId, app.ownerId),
        eq(subscriptions.status, "active"),
      ),
    )
    .orderBy(desc(subscriptions.createdAt))
    .limit(1);
  const ownerSubscription = ownerSubRows[0] ?? null;

  let planRow: typeof plans.$inferSelect | null = null;
  if (ownerSubscription) {
    const pr = await db
      .select()
      .from(plans)
      .where(eq(plans.id, ownerSubscription.planId))
      .limit(1);
    planRow = pr[0] ?? null;
  }

  if (!planRow) {
    const fallbackPlans = await db
      .select()
      .from(plans)
      .where(
        and(eq(plans.clientId, app.id), eq(plans.status, "active")),
      )
      .orderBy(desc(plans.updatedAt))
      .limit(1);
    planRow = fallbackPlans[0] ?? null;
  }

  let periodStart: string;
  let periodEnd: string;
  if (
    ownerSubscription?.currentPeriodStart &&
    ownerSubscription?.currentPeriodEnd
  ) {
    periodStart = ownerSubscription.currentPeriodStart;
    periodEnd = ownerSubscription.currentPeriodEnd;
  } else {
    const cal = calendarMonthBoundsUtc(new Date());
    periodStart = cal.start;
    periodEnd = cal.end;
  }

  const rows = await db
    .select()
    .from(usageRecords)
    .where(
      and(
        eq(usageRecords.clientId, app.id),
        gte(usageRecords.createdAt, periodStart),
        lte(usageRecords.createdAt, periodEnd),
      ),
    );

  let totalFeeWei = 0n;
  let totalUnits = 0n;
  const byDay = new Map<string, { requestCount: number; feeWei: bigint }>();

  for (const row of rows) {
    const feeStr = row.fee || "0";
    totalFeeWei += BigInt(feeStr);
    totalUnits += BigInt(row.units || "0");
    const day = dateKeyFromIso(row.createdAt);
    const cur = byDay.get(day) || { requestCount: 0, feeWei: 0n };
    cur.requestCount += 1;
    cur.feeWei += BigInt(feeStr);
    byDay.set(day, cur);
  }

  // Fetch billing events for the period to get USD-denominated breakdown
  const usageRecordIds = rows.map((r) => r.id).filter(Boolean);
  const billingEvents =
    usageRecordIds.length > 0
      ? await db
          .select()
          .from(usageBillingEvents)
          .where(
            and(
              eq(usageBillingEvents.clientId, app.id),
              inArray(usageBillingEvents.usageRecordId, usageRecordIds),
            ),
          )
      : [];

  let totalNetworkFeeWei = 0n;
  let totalNetworkFeeUsdMicros = 0n;
  let totalPlatformFeeUsdMicros = 0n;
  let totalOwnerChargeWei = 0n;
  let totalOwnerChargeUsdMicros = 0n;
  let totalEndUserBillableUsdMicros = 0n;

  // Pipeline/model breakdown
  const byPipelineModel = new Map<string, {
    pipeline: string;
    modelId: string;
    networkFeeWei: bigint;
    networkFeeUsdMicros: bigint;
    ownerChargeUsdMicros: bigint;
    endUserBillableUsdMicros: bigint;
    count: number;
  }>();

  for (const e of billingEvents) {
    totalNetworkFeeWei += BigInt(e.networkFeeWei);
    totalNetworkFeeUsdMicros += BigInt(e.networkFeeUsdMicros);
    totalPlatformFeeUsdMicros += BigInt(e.platformFeeUsdMicros);
    totalOwnerChargeWei += BigInt(e.ownerChargeWei);
    totalOwnerChargeUsdMicros += BigInt(e.ownerChargeUsdMicros);
    totalEndUserBillableUsdMicros += BigInt(e.endUserBillableUsdMicros);

    const key = `${e.pipeline}|${e.modelId}`;
    const existing = byPipelineModel.get(key) || {
      pipeline: e.pipeline,
      modelId: e.modelId,
      networkFeeWei: 0n,
      networkFeeUsdMicros: 0n,
      ownerChargeUsdMicros: 0n,
      endUserBillableUsdMicros: 0n,
      count: 0,
    };
    existing.networkFeeWei += BigInt(e.networkFeeWei);
    existing.networkFeeUsdMicros += BigInt(e.networkFeeUsdMicros);
    existing.ownerChargeUsdMicros += BigInt(e.ownerChargeUsdMicros);
    existing.endUserBillableUsdMicros += BigInt(e.endUserBillableUsdMicros);
    existing.count += 1;
    byPipelineModel.set(key, existing);
  }

  const timelineDates = dateKeysInclusiveUtc(periodStart, periodEnd);
  const timeline = timelineDates.map((date) => {
    const bucket = byDay.get(date);
    return {
      date,
      requestCount: bucket?.requestCount ?? 0,
      feeWei: (bucket?.feeWei ?? 0n).toString(),
    };
  });

  const planType = planRow?.type ?? "free";
  let overageUnits = "0";
  let overageWei = "0";
  if (
    (planType === "subscription" || planType === "usage") &&
    planRow?.includedUnits != null &&
    planRow?.overageRateWei != null
  ) {
    const included = BigInt(planRow.includedUnits);
    const rate = BigInt(planRow.overageRateWei);
    if (totalUnits > included) {
      const over = totalUnits - included;
      overageUnits = over.toString();
      overageWei = (over * rate).toString();
    }
  }

  // Subscription USD allowance consumption
  const includedUsdMicros = planRow?.includedUsdMicros ? BigInt(planRow.includedUsdMicros) : 0n;
  const consumedUsdMicros =
    totalEndUserBillableUsdMicros < includedUsdMicros
      ? totalEndUserBillableUsdMicros
      : includedUsdMicros;
  const remainingUsdMicros = includedUsdMicros > consumedUsdMicros
    ? includedUsdMicros - consumedUsdMicros
    : 0n;

  return NextResponse.json({
    clientId,
    plan: planRow
      ? {
          id: planRow.id,
          type: planRow.type,
          name: planRow.name,
          priceAmount: planRow.priceAmount,
          priceCurrency: planRow.priceCurrency,
          includedUnits: planRow.includedUnits != null ? planRow.includedUnits.toString() : null,
          overageRateWei: planRow.overageRateWei != null ? planRow.overageRateWei.toString() : null,
          includedUsdMicros: planRow.includedUsdMicros ?? null,
          billingCycle: planRow.billingCycle,
          status: planRow.status,
        }
      : null,
    subscription: ownerSubscription
      ? {
          id: ownerSubscription.id,
          status: ownerSubscription.status,
          currentPeriodStart: ownerSubscription.currentPeriodStart,
          currentPeriodEnd: ownerSubscription.currentPeriodEnd,
        }
      : null,
    cycle: {
      periodStart,
      periodEnd,
      usage: {
        requestCount: rows.length,
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
      byPipelineModel: [...byPipelineModel.values()].map((d) => ({
        pipeline: d.pipeline,
        modelId: d.modelId,
        requestCount: d.count,
        networkFeeWei: d.networkFeeWei.toString(),
        networkFeeEth: weiToEthString(d.networkFeeWei),
        networkFeeUsdMicros: d.networkFeeUsdMicros.toString(),
        ownerChargeUsdMicros: d.ownerChargeUsdMicros.toString(),
        endUserBillableUsdMicros: d.endUserBillableUsdMicros.toString(),
      })),
    },
    platformCutPercent,
  });
}
