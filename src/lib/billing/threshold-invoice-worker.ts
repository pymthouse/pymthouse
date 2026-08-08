/**
 * Clearinghouse threshold sweep: raise gathering invoices when unpaid totals
 * reach the effective Pay-Per-Use / app invoice threshold, then let Plane A
 * (OM Stripe) or Plane C (settlement Custom Invoicing) collect.
 */
import { and, eq, inArray, isNotNull, or } from "drizzle-orm";

import { db } from "@/db/index";
import {
  appBillingConfig,
  developerApps,
  plans,
  subscriptions,
} from "@/db/schema";
import { resolveEffectiveInvoiceThresholdUsdMicros } from "@/lib/billing/effective-invoice-threshold";
import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "@/lib/openmeter/admin-client";
import {
  ensureOwnerCustomer,
  findOpenMeterCustomerByKey,
  listOwnedPublicClientIds,
} from "@/lib/openmeter/customers";
import { decimalDollarsToUsdMicros } from "@/lib/openmeter/konnect-credits";
import { resolveOpenMeterMeterClientId } from "@/lib/openmeter/meter-client-id";
import { buildOpenMeterCustomerKey } from "@/lib/openmeter/customer-key";
import { sanitizeForLog } from "@/lib/sanitize-for-log";

export type ThresholdInvoiceSweepResult = {
  appsConsidered: number;
  customersChecked: number;
  invoicesRaised: number;
  skipped: number;
  errors: number;
};

/** Parse OpenMeter gathering invoice `totals.total` into USD micros. */
export function gatheringTotalUsdMicros(total: unknown): bigint | null {
  if (total == null) return null;
  try {
    if (typeof total === "number" && Number.isFinite(total)) {
      return decimalDollarsToUsdMicros(String(total));
    }
    if (typeof total === "string") {
      const trimmed = total.trim();
      if (!trimmed) return null;
      // Some payloads already look like integer micros; prefer dollars when
      // a decimal point is present or the magnitude is small.
      if (/^-?\d+$/.test(trimmed) && trimmed.length > 8) {
        return BigInt(trimmed);
      }
      return decimalDollarsToUsdMicros(trimmed);
    }
  } catch {
    return null;
  }
  return null;
}

/** True when any gathering total has reached the effective threshold. */
export function gatheringInvoiceMeetsThreshold(
  totals: unknown[],
  thresholdUsdMicros: bigint,
): boolean {
  for (const total of totals) {
    const micros = gatheringTotalUsdMicros(total);
    if (micros != null && micros >= thresholdUsdMicros) {
      return true;
    }
  }
  return false;
}

async function raiseInvoiceForCustomer(customerId: string): Promise<boolean> {
  const client = getHostedAdminClient();
  // SDK `invoicePendingLines` posts to /billing/invoices/invoice with the
  // customer id — raises gathering lines into a collectible invoice.
  await client.billing.invoices.invoicePendingLines({
    customerId,
  });
  return true;
}

async function customerIdsForApp(input: {
  appId: string;
  billingMode: string | null | undefined;
  ownerId: string | null | undefined;
}): Promise<Array<{ customerId: string; externalUserId: string | null }>> {
  const client = getHostedAdminClient();
  const out: Array<{ customerId: string; externalUserId: string | null }> = [];

  if (input.billingMode === "merchant") {
    const subs = await db
      .select({
        externalUserId: subscriptions.externalUserId,
      })
      .from(subscriptions)
      .innerJoin(plans, eq(subscriptions.planId, plans.id))
      .where(
        and(
          eq(subscriptions.clientId, input.appId),
          inArray(subscriptions.status, ["active", "trialing"]),
          or(eq(plans.type, "usage"), eq(plans.type, "subscription")),
        ),
      );

    const seen = new Set<string>();
    const publicClientId = await resolveOpenMeterMeterClientId(input.appId);
    for (const row of subs) {
      const externalUserId = row.externalUserId?.trim();
      if (!externalUserId || seen.has(externalUserId)) continue;
      seen.add(externalUserId);
      const key = buildOpenMeterCustomerKey(publicClientId, externalUserId);
      const customer = await findOpenMeterCustomerByKey(client, key);
      const customerId = customer?.id?.trim();
      if (customerId) {
        out.push({ customerId, externalUserId });
      }
    }
    return out;
  }

  // owner_rollup — owner shared wallet is the cost rail.
  const ownerId = input.ownerId?.trim();
  if (!ownerId) return out;
  const publicClientIds = await listOwnedPublicClientIds(ownerId);
  const ownerCustomer = await ensureOwnerCustomer(
    client,
    ownerId,
    publicClientIds,
  );
  if (ownerCustomer.id?.trim()) {
    out.push({ customerId: ownerCustomer.id.trim(), externalUserId: null });
  }
  return out;
}

/**
 * Scan apps with an invoice / PPU charge threshold and raise gathering invoices
 * that have reached the effective threshold.
 */
export async function runThresholdInvoiceSweep(): Promise<ThresholdInvoiceSweepResult> {
  const result: ThresholdInvoiceSweepResult = {
    appsConsidered: 0,
    customersChecked: 0,
    invoicesRaised: 0,
    skipped: 0,
    errors: 0,
  };

  if (!isHostedAdminClientAvailable()) {
    return result;
  }

  const client = getHostedAdminClient();

  const appsWithAppThreshold = await db
    .select({
      appId: appBillingConfig.clientId,
      billingMode: appBillingConfig.billingMode,
      ownerId: developerApps.ownerId,
    })
    .from(appBillingConfig)
    .innerJoin(
      developerApps,
      eq(appBillingConfig.clientId, developerApps.id),
    )
    .where(isNotNull(appBillingConfig.invoiceThresholdUsdMicros));

  const appsWithPlanThreshold = await db
    .selectDistinct({
      appId: plans.clientId,
    })
    .from(plans)
    .where(
      and(
        eq(plans.type, "usage"),
        eq(plans.status, "active"),
        isNotNull(plans.chargeThresholdUsdMicros),
      ),
    );

  const appIds = new Set<string>();
  const appMeta = new Map<
    string,
    { billingMode: string | null; ownerId: string | null }
  >();

  for (const row of appsWithAppThreshold) {
    const id = row.appId?.trim();
    if (!id) continue;
    appIds.add(id);
    appMeta.set(id, {
      billingMode: row.billingMode ?? null,
      ownerId: row.ownerId ?? null,
    });
  }
  for (const row of appsWithPlanThreshold) {
    const id = row.appId?.trim();
    if (!id) continue;
    appIds.add(id);
    if (!appMeta.has(id)) {
      const appRows = await db
        .select({
          billingMode: appBillingConfig.billingMode,
          ownerId: developerApps.ownerId,
        })
        .from(developerApps)
        .leftJoin(
          appBillingConfig,
          eq(appBillingConfig.clientId, developerApps.id),
        )
        .where(eq(developerApps.id, id))
        .limit(1);
      appMeta.set(id, {
        billingMode: appRows[0]?.billingMode ?? null,
        ownerId: appRows[0]?.ownerId ?? null,
      });
    }
  }

  for (const appId of appIds) {
    result.appsConsidered += 1;
    const meta = appMeta.get(appId) ?? { billingMode: null, ownerId: null };
    let customers: Array<{ customerId: string; externalUserId: string | null }>;
    try {
      customers = await customerIdsForApp({
        appId,
        billingMode: meta.billingMode,
        ownerId: meta.ownerId,
      });
    } catch (err) {
      result.errors += 1;
      console.warn(
        "threshold-invoice-worker: list customers failed",
        sanitizeForLog(appId),
        sanitizeForLog(err),
      );
      continue;
    }

    for (const entry of customers) {
      result.customersChecked += 1;
      try {
        const threshold = await resolveEffectiveInvoiceThresholdUsdMicros({
          appId,
          externalUserId: entry.externalUserId,
        });
        if (threshold == null) {
          result.skipped += 1;
          continue;
        }

        const listed = await client.billing.invoices.list({
          customers: [entry.customerId],
          page: 1,
          pageSize: 20,
          order: "DESC",
          orderBy: "createdAt",
        });
        const gathering = (listed?.items ?? []).filter(
          (inv) => String(inv.status ?? "").toLowerCase() === "gathering",
        );
        if (gathering.length === 0) {
          result.skipped += 1;
          continue;
        }

        const due = gatheringInvoiceMeetsThreshold(
          gathering.map((inv) => inv.totals?.total),
          threshold,
        );
        if (!due) {
          result.skipped += 1;
          continue;
        }

        await raiseInvoiceForCustomer(entry.customerId);
        result.invoicesRaised += 1;
      } catch (err) {
        result.errors += 1;
        console.warn(
          "threshold-invoice-worker: customer sweep failed",
          sanitizeForLog(appId),
          sanitizeForLog(entry.customerId),
          sanitizeForLog(err),
        );
      }
    }
  }

  return result;
}
