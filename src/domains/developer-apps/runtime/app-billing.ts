import type { NextRequest } from "next/server";
import { getProviderAppForClientOrDashboard } from "./app-access";
import {
  getLatestActivePlanForApp,
  getOwnerActiveSubscription,
  getPlanById,
  getPlatformCutPercent,
  listUsageBillingEventsForUsageRecords,
  listUsageRecordsForBillingPeriod,
} from "../repo/app-billing";
import { buildBillingCycleSummary, resolveBillingPeriod } from "../service/app-billing";

export async function readAppBilling(request: NextRequest, clientId: string): Promise<
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: 404; body: { error: string } }
> {
  const app = await getProviderAppForClientOrDashboard(request, clientId);
  if (!app) {
    return { ok: false, status: 404, body: { error: "Not found" } };
  }

  const platformCutPercent = await getPlatformCutPercent();
  const ownerSubscription = await getOwnerActiveSubscription(app.id, app.ownerId);

  let planRow = ownerSubscription ? await getPlanById(ownerSubscription.planId) : null;
  if (!planRow) {
    planRow = await getLatestActivePlanForApp(app.id);
  }

  const { periodStart, periodEnd } = resolveBillingPeriod({
    currentPeriodStart: ownerSubscription?.currentPeriodStart ?? null,
    currentPeriodEnd: ownerSubscription?.currentPeriodEnd ?? null,
    now: new Date(),
  });

  const usageRows = await listUsageRecordsForBillingPeriod({
    appId: app.id,
    periodStart,
    periodEnd,
  });
  const billingEvents = await listUsageBillingEventsForUsageRecords({
    appId: app.id,
    usageRecordIds: usageRows.map((row) => row.id).filter(Boolean),
  });

  const cycle = buildBillingCycleSummary({
    usageRows: usageRows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      fee: row.fee || "0",
      units: row.units || "0",
    })),
    billingEvents: billingEvents.map((event) => ({
      pipeline: event.pipeline,
      modelId: event.modelId,
      networkFeeWei: event.networkFeeWei,
      networkFeeUsdMicros: event.networkFeeUsdMicros,
      platformFeeUsdMicros: event.platformFeeUsdMicros,
      ownerChargeWei: event.ownerChargeWei,
      ownerChargeUsdMicros: event.ownerChargeUsdMicros,
      endUserBillableUsdMicros: event.endUserBillableUsdMicros,
    })),
    periodStart,
    periodEnd,
    plan: planRow
      ? {
          type: planRow.type,
          includedUnits: planRow.includedUnits != null ? planRow.includedUnits.toString() : null,
          overageRateWei: planRow.overageRateWei != null ? planRow.overageRateWei.toString() : null,
          includedUsdMicros: planRow.includedUsdMicros ?? null,
        }
      : null,
  });

  return {
    ok: true,
    body: {
      clientId,
      plan: planRow
        ? {
            id: planRow.id,
            type: planRow.type,
            name: planRow.name,
            priceAmount: planRow.priceAmount,
            priceCurrency: planRow.priceCurrency,
            includedUnits:
              planRow.includedUnits != null ? planRow.includedUnits.toString() : null,
            overageRateWei:
              planRow.overageRateWei != null ? planRow.overageRateWei.toString() : null,
            includedUsdMicros: planRow.includedUsdMicros ?? null,
            generalUpchargePercentBps: planRow.generalUpchargePercentBps ?? null,
            payPerUseUpchargePercentBps: planRow.payPerUseUpchargePercentBps ?? null,
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
        ...cycle,
      },
      platformCutPercent,
    },
  };
}
