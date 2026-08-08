/**
 * Effective invoice / charge threshold for Pay-Per-Use auto-debit.
 *
 * Prefer the customer's active usage-plan `chargeThresholdUsdMicros`, then the
 * app-level `invoiceThresholdUsdMicros`. Returned as integer USD micros.
 */
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";

import { db } from "@/db/index";
import { plans, subscriptions } from "@/db/schema";
import {
  getAppBillingConfig,
  upsertAppBillingConfig,
} from "@/lib/openmeter/billing-profiles";

function parsePositiveMicros(raw: string | null | undefined): bigint | null {
  if (!raw?.trim()) return null;
  try {
    const value = BigInt(raw.trim());
    return value > 0n ? value : null;
  } catch {
    return null;
  }
}

/** Prefer plan charge threshold; fall back to app invoice threshold. */
export function pickEffectiveThresholdUsdMicros(input: {
  planChargeThresholdUsdMicros?: string | null;
  appInvoiceThresholdUsdMicros?: string | null;
}): bigint | null {
  return (
    parsePositiveMicros(input.planChargeThresholdUsdMicros) ??
    parsePositiveMicros(input.appInvoiceThresholdUsdMicros)
  );
}

/**
 * Resolve the threshold that should raise a gathering invoice for this
 * end-user (merchant) or return the app default (rollup / no plan threshold).
 */
export async function resolveEffectiveInvoiceThresholdUsdMicros(input: {
  appId: string;
  externalUserId?: string | null;
}): Promise<bigint | null> {
  const appId = input.appId.trim();
  if (!appId) return null;

  const config = await getAppBillingConfig(appId);
  const appThreshold = config?.invoiceThresholdUsdMicros ?? null;

  const externalUserId = input.externalUserId?.trim();
  if (!externalUserId) {
    return pickEffectiveThresholdUsdMicros({
      appInvoiceThresholdUsdMicros: appThreshold,
    });
  }

  const planRows = await db
    .select({
      chargeThresholdUsdMicros: plans.chargeThresholdUsdMicros,
    })
    .from(subscriptions)
    .innerJoin(plans, eq(subscriptions.planId, plans.id))
    .where(
      and(
        eq(subscriptions.clientId, appId),
        eq(subscriptions.externalUserId, externalUserId),
        inArray(subscriptions.status, ["active", "trialing"]),
        eq(plans.type, "usage"),
      ),
    )
    .orderBy(desc(subscriptions.createdAt))
    .limit(1);

  return pickEffectiveThresholdUsdMicros({
    planChargeThresholdUsdMicros: planRows[0]?.chargeThresholdUsdMicros,
    appInvoiceThresholdUsdMicros: appThreshold,
  });
}

/**
 * Keep `app_billing_config.invoice_threshold_usd_micros` in sync with the
 * lowest active usage-plan charge threshold on the app (so progressive /
 * worker paths have an app-level floor even when no end-user plan is resolved).
 */
export async function syncAppInvoiceThresholdFromUsagePlans(
  appId: string,
): Promise<string | null> {
  const trimmed = appId.trim();
  if (!trimmed) return null;

  const usagePlans = await db
    .select({
      chargeThresholdUsdMicros: plans.chargeThresholdUsdMicros,
    })
    .from(plans)
    .where(
      and(
        eq(plans.clientId, trimmed),
        eq(plans.type, "usage"),
        eq(plans.status, "active"),
        isNotNull(plans.chargeThresholdUsdMicros),
      ),
    );

  let lowest: bigint | null = null;
  for (const row of usagePlans) {
    const micros = parsePositiveMicros(row.chargeThresholdUsdMicros);
    if (micros == null) continue;
    if (lowest == null || micros < lowest) {
      lowest = micros;
    }
  }

  const next = lowest?.toString() ?? null;
  const existing = await getAppBillingConfig(trimmed);
  if ((existing?.invoiceThresholdUsdMicros ?? null) === next) {
    return next;
  }

  await upsertAppBillingConfig(trimmed, {
    invoiceThresholdUsdMicros: next,
  });

  return next;
}
