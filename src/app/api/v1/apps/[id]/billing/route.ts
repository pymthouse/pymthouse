import { NextRequest, NextResponse } from "next/server";
import { authenticateAppClient } from "@/lib/auth";
import { db } from "@/db/index";
import { plans, signerConfig, subscriptions } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { getAuthorizedProviderApp, getProviderApp } from "@/lib/provider-apps";
import { calendarMonthBoundsUtc, dateKeysInclusiveUtc } from "@/lib/billing-utils";
import { getHostedAdminClient, isHostedAdminClientAvailable } from "@/lib/openmeter/admin-client";
import { requireOpenMeterForUsageReads } from "@/lib/openmeter/constants";
import { verifyOpenMeterSubscriptionId } from "@/lib/openmeter/subscription-read";
import {
  queryOpenMeterAppDashboardUsage,
  queryOpenMeterUsage,
} from "@/lib/usage/query-openmeter";

function buildBillingSubscriptionPayload(input: {
  openMeterOwnerSubscription: Awaited<ReturnType<typeof verifyOpenMeterSubscriptionId>>;
  ownerSubscription: (typeof subscriptions.$inferSelect) | null;
}) {
  if (input.openMeterOwnerSubscription) {
    return {
      id: input.ownerSubscription?.id ?? input.openMeterOwnerSubscription.id,
      status: input.openMeterOwnerSubscription.status,
      currentPeriodStart: input.openMeterOwnerSubscription.activeFrom,
      currentPeriodEnd: input.openMeterOwnerSubscription.activeTo,
      openmeterSubscriptionId: input.openMeterOwnerSubscription.id,
      source: "openmeter" as const,
    };
  }
  if (input.ownerSubscription) {
    return {
      id: input.ownerSubscription.id,
      status: input.ownerSubscription.status,
      currentPeriodStart: input.ownerSubscription.currentPeriodStart,
      currentPeriodEnd: input.ownerSubscription.currentPeriodEnd,
      source: "legacy_cache" as const,
    };
  }
  return null;
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

  if (!requireOpenMeterForUsageReads()) {
    return NextResponse.json(
      { error: "OpenMeter not configured (OPENMETER_URL required)" },
      { status: 503 },
    );
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
      .where(and(eq(plans.clientId, app.id), eq(plans.status, "active")))
      .orderBy(desc(plans.updatedAt))
      .limit(1);
    planRow = fallbackPlans[0] ?? null;
  }

  let openMeterOwnerSubscription: Awaited<
    ReturnType<typeof verifyOpenMeterSubscriptionId>
  > = null;
  if (
    ownerSubscription?.openmeterSubscriptionId &&
    isHostedAdminClientAvailable()
  ) {
    openMeterOwnerSubscription = await verifyOpenMeterSubscriptionId(
      getHostedAdminClient(),
      ownerSubscription.openmeterSubscriptionId,
    );
  }

  let periodStart: string;
  let periodEnd: string;
  if (openMeterOwnerSubscription?.activeFrom && openMeterOwnerSubscription?.activeTo) {
    periodStart = openMeterOwnerSubscription.activeFrom;
    periodEnd = openMeterOwnerSubscription.activeTo;
  } else if (
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

  const [omRows, omDashboard] = await Promise.all([
    queryOpenMeterUsage({
      clientId: app.id,
      startDate: periodStart,
      endDate: periodEnd,
    }),
    queryOpenMeterAppDashboardUsage({
      clientId: app.id,
      startDate: periodStart,
      endDate: periodEnd,
    }),
  ]);

  const omRequestCount = omRows.reduce((sum, row) => sum + row.requestCount, 0);
  const omNetworkFeeUsdMicros = omRows.reduce(
    (sum, row) => sum + BigInt(row.networkFeeUsdMicros),
    0n,
  );
  const omEndUserBillableUsdMicros = omNetworkFeeUsdMicros;
  const omOwnerChargeUsdMicros = omNetworkFeeUsdMicros;

  const byDay = new Map<string, { requestCount: number }>();
  if (omDashboard?.requestsByDay) {
    for (const [date, count] of omDashboard.requestsByDay) {
      byDay.set(date, { requestCount: count });
    }
  }

  const timelineDates = dateKeysInclusiveUtc(periodStart, periodEnd);
  const timeline = timelineDates.map((date) => {
    const bucket = byDay.get(date);
    return {
      date,
      requestCount: bucket?.requestCount ?? 0,
      feeWei: "0",
    };
  });

  const planType = planRow?.type ?? "free";
  const totalUnits = 0n;
  let overageUnits = "0";
  let overageWei = "0";
  if (
    (planType === "subscription" || planType === "usage") &&
    planRow?.includedUnits != null
  ) {
    const included = BigInt(planRow.includedUnits);
    if (totalUnits > included) {
      overageUnits = (totalUnits - included).toString();
    }
  }

  const includedUsdMicros = planRow?.includedUsdMicros
    ? BigInt(planRow.includedUsdMicros)
    : 0n;

  const consumedUsdMicrosFinal =
    omEndUserBillableUsdMicros < includedUsdMicros
      ? omEndUserBillableUsdMicros
      : includedUsdMicros;
  const remainingUsdMicrosFinal =
    includedUsdMicros > consumedUsdMicrosFinal
      ? includedUsdMicros - consumedUsdMicrosFinal
      : 0n;

  const byPipelineModel = (omDashboard?.byPipelineModel ?? []).map((d) => ({
    pipeline: d.pipeline,
    modelId: d.modelId,
    requestCount: d.requestCount,
    networkFeeWei: "0",
    networkFeeEth: "0",
    networkFeeUsdMicros: d.networkFeeUsdMicros,
    ownerChargeUsdMicros: d.networkFeeUsdMicros,
    endUserBillableUsdMicros: d.networkFeeUsdMicros,
  }));

  return NextResponse.json({
    clientId,
    usageSource: "openmeter",
    plan: planRow
      ? {
          id: planRow.id,
          type: planRow.type,
          name: planRow.name,
          priceAmount: planRow.priceAmount,
          priceCurrency: planRow.priceCurrency,
          overageRateUsd: planRow.overageRateUsd ?? null,
          includedUsdMicros: planRow.includedUsdMicros ?? null,
          billingCycle: planRow.billingCycle,
          status: planRow.status,
        }
      : null,
    subscription: buildBillingSubscriptionPayload({
      openMeterOwnerSubscription,
      ownerSubscription,
    }),
    cycle: {
      periodStart,
      periodEnd,
      usage: {
        requestCount: omRequestCount,
        totalFeeWei: "0",
        totalFeeEth: "0",
        totalUnits: totalUnits.toString(),
      },
      timeline,
      overage: { overageUnits, overageWei },
      ownerCost: {
        networkFeeWei: "0",
        networkFeeEth: "0",
        networkFeeUsdMicros: omNetworkFeeUsdMicros.toString(),
        platformFeeUsdMicros: "0",
        ownerChargeWei: "0",
        ownerChargeEth: "0",
        ownerChargeUsdMicros: omOwnerChargeUsdMicros.toString(),
      },
      retail: {
        endUserBillableUsdMicros: omEndUserBillableUsdMicros.toString(),
        includedUsdMicros: includedUsdMicros.toString(),
        consumedIncludedUsdMicros: consumedUsdMicrosFinal.toString(),
        remainingIncludedUsdMicros: remainingUsdMicrosFinal.toString(),
      },
      byPipelineModel,
    },
    platformCutPercent,
  });
}
