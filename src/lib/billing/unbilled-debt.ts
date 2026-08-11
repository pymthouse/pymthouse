/**
 * Resolve unbilled debt (USD micros) for soft-negative gating / invoice trigger.
 * Prefer gathering invoice totals; fall back to calendar-month meter usage net of
 * remaining included usage (OM-billable amount).
 */
import { calendarMonthBoundsUtc } from "@/lib/billing-utils";
import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "@/lib/openmeter/admin-client";
import { resolveOpenMeterBillingIdentity } from "@/lib/openmeter/billing-identity";
import { getAppBillingConfig } from "@/lib/openmeter/billing-profiles";
import { NETWORK_FEE_USD_MICROS_METER, getHostedOpenMeterUrl, isKonnectMeteringUrl } from "@/lib/openmeter/constants";
import { buildOwnerMeterSubjects } from "@/lib/openmeter/customer-key";
import {
  ensureOpenMeterCustomer,
  ensureOwnerCustomer,
  findOpenMeterCustomerByKey,
  listOwnedPublicClientIds,
} from "@/lib/openmeter/customers";
import { decimalDollarsToUsdMicros } from "@/lib/openmeter/konnect-credits";
import { konnectMeteringV1Fetch } from "@/lib/openmeter/konnect-admin-client";
import { resolveOpenMeterMeterClientId } from "@/lib/openmeter/meter-client-id";
import { getProviderApp } from "@/lib/provider-apps";
import { getRemainingPlanDiscountUsdMicros } from "@/lib/openmeter/spendable-allowance";
import {
  ceilExactUsdMicrosSum,
  meterRowValueToNumber,
} from "@/lib/openmeter/usage-read";

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

/** Net meter estimate against remaining included usage (never negative). */
export function netBillableMeterDebtUsdMicros(input: {
  meterUsdMicros: bigint;
  remainingIncludedUsdMicros: bigint;
}): bigint {
  const remaining =
    input.remainingIncludedUsdMicros > 0n
      ? input.remainingIncludedUsdMicros
      : 0n;
  return input.meterUsdMicros > remaining
    ? input.meterUsdMicros - remaining
    : 0n;
}

type GatheringInvoiceRow = {
  status?: string | null;
  customer?: { id?: string | null } | null;
  customerId?: string | null;
  customer_id?: string | null;
  totals?: { total?: unknown } | null;
};

function invoiceCustomerId(inv: GatheringInvoiceRow): string | null {
  return (
    inv.customer?.id?.trim() ||
    (typeof inv.customerId === "string" ? inv.customerId.trim() : null) ||
    (typeof inv.customer_id === "string" ? inv.customer_id.trim() : null) ||
    null
  );
}

function maxGatheringFromItems(
  items: GatheringInvoiceRow[],
  customerId: string,
): bigint | null {
  let max = 0n;
  let found = false;
  for (const inv of items) {
    if (String(inv.status ?? "").toLowerCase() !== "gathering") {
      continue;
    }
    const invCustomer = invoiceCustomerId(inv);
    if (invCustomer && invCustomer !== customerId) {
      continue;
    }
    const micros = gatheringTotalUsdMicros(inv.totals?.total);
    if (micros == null) continue;
    found = true;
    if (micros > max) max = micros;
  }
  return found ? max : null;
}

/**
 * Konnect `customers` list filter is often ignored on `/v3/openmeter`. Prefer
 * `/metering/v1` with an explicit customer filter, then client-side match.
 */
async function maxGatheringDebtViaMeteringV1(
  customerId: string,
): Promise<bigint | null> {
  try {
    const params = new URLSearchParams();
    params.set("filter[customer.id][eq]", customerId);
    params.set("filter[status][eq]", "gathering");
    params.set("page[size]", "20");
    params.set("page[number]", "1");
    const listed = await konnectMeteringV1Fetch<{
      items?: GatheringInvoiceRow[];
    }>(`/billing/invoices?${params.toString()}`, { method: "GET" }, "gathering-invoices");
    return maxGatheringFromItems(listed?.items ?? [], customerId);
  } catch {
    // Fall through to alternate filter shapes / SDK list.
    try {
      const params = new URLSearchParams();
      params.set("filter[customer_id][eq]", customerId);
      params.set("statuses", "gathering");
      params.set("page[size]", "20");
      const listed = await konnectMeteringV1Fetch<{
        items?: GatheringInvoiceRow[];
      }>(
        `/billing/invoices?${params.toString()}`,
        { method: "GET" },
        "gathering-invoices",
      );
      return maxGatheringFromItems(listed?.items ?? [], customerId);
    } catch {
      return null;
    }
  }
}

async function maxGatheringDebtUsdMicros(
  customerId: string,
): Promise<bigint | null> {
  if (!isHostedAdminClientAvailable()) {
    return null;
  }

  const openmeterUrl = getHostedOpenMeterUrl();
  if (isKonnectMeteringUrl(openmeterUrl)) {
    const viaMetering = await maxGatheringDebtViaMeteringV1(customerId);
    if (viaMetering != null) {
      return viaMetering;
    }
  }

  try {
    const client = getHostedAdminClient();
    const listed = await client.billing.invoices.list({
      customers: [customerId],
      page: 1,
      pageSize: 20,
      order: "DESC",
      orderBy: "createdAt",
    });
    return maxGatheringFromItems(listed?.items ?? [], customerId);
  } catch {
    return null;
  }
}

async function periodMeterDebtUsdMicros(subjects: string[]): Promise<bigint> {
  if (!isHostedAdminClientAvailable()) {
    return 0n;
  }
  const unique = [...new Set(subjects.map((s) => s.trim()).filter(Boolean))];
  if (unique.length === 0) {
    return 0n;
  }
  const cycle = calendarMonthBoundsUtc(new Date());
  try {
    const client = getHostedAdminClient();
    const result = await client.meters.query(NETWORK_FEE_USD_MICROS_METER, {
      windowSize: "MONTH",
      from: new Date(cycle.start),
      to: new Date(cycle.end),
      subject: unique,
    });
    let usedExact = 0;
    for (const row of result.data || []) {
      usedExact += meterRowValueToNumber(row.value);
    }
    return ceilExactUsdMicrosSum(usedExact);
  } catch {
    return 0n;
  }
}

async function resolveBillingCustomerAndSubjects(input: {
  clientId: string;
  externalUserId: string;
}): Promise<{ customerId: string | null; meterSubjects: string[] }> {
  const identity = await resolveOpenMeterBillingIdentity({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });
  const client = getHostedAdminClient();
  const app = await getProviderApp(input.clientId);
  const appId = app?.id?.trim() || identity.developerAppId;
  const billingConfig = await getAppBillingConfig(appId);
  const merchant = billingConfig?.billingMode === "merchant";

  if (identity.isOwner && identity.ownerUserId) {
    const publicClientIds = await listOwnedPublicClientIds(identity.ownerUserId);
    const ownerCustomer = await ensureOwnerCustomer(
      client,
      identity.ownerUserId,
      publicClientIds,
    );
    return {
      customerId: ownerCustomer.id?.trim() || null,
      meterSubjects: buildOwnerMeterSubjects(identity.ownerUserId, [
        identity.publicClientId,
        ...publicClientIds,
      ]),
    };
  }
  if (merchant) {
    const publicClientId = await resolveOpenMeterMeterClientId(appId);
    const key = `${publicClientId}:${input.externalUserId}`;
    const customer = await findOpenMeterCustomerByKey(client, key);
    return {
      customerId: customer?.id?.trim() || null,
      meterSubjects: [key],
    };
  }
  await ensureOpenMeterCustomer(client, identity.customerKey);
  const customer = await findOpenMeterCustomerByKey(
    client,
    identity.customerKey,
  );
  return {
    customerId: customer?.id?.trim() || null,
    meterSubjects: [identity.customerKey],
  };
}

/** OpenMeter customer id for the billing identity (owner / merchant / rollup). */
export async function resolveBillingCustomerId(input: {
  clientId: string;
  externalUserId: string;
}): Promise<string | null> {
  if (!isHostedAdminClientAvailable()) {
    return null;
  }
  const clientId = input.clientId.trim();
  const externalUserId = input.externalUserId.trim();
  if (!clientId || !externalUserId) {
    return null;
  }
  const resolved = await resolveBillingCustomerAndSubjects({
    clientId,
    externalUserId,
  });
  return resolved.customerId;
}

/** Which read produced a debt figure — surfaced so integrators can tell. */
export type UnbilledDebtSource =
  | "gathering_invoice"
  | "meter_estimate"
  | "unavailable";

/**
 * Unbilled debt for soft-negative gating. Gathering total when present,
 * else period network-fee meter sum net of remaining included usage.
 */
export async function getUnbilledDebtDetails(input: {
  clientId: string;
  externalUserId: string;
}): Promise<{ usdMicros: bigint; source: UnbilledDebtSource }> {
  if (!isHostedAdminClientAvailable()) {
    return { usdMicros: 0n, source: "unavailable" };
  }
  const clientId = input.clientId.trim();
  const externalUserId = input.externalUserId.trim();
  if (!clientId || !externalUserId) {
    return { usdMicros: 0n, source: "unavailable" };
  }

  const { customerId, meterSubjects } = await resolveBillingCustomerAndSubjects({
    clientId,
    externalUserId,
  });

  if (customerId) {
    const gathering = await maxGatheringDebtUsdMicros(customerId);
    if (gathering != null) {
      return { usdMicros: gathering, source: "gathering_invoice" };
    }
  }

  const [meter, remainingIncluded] = await Promise.all([
    periodMeterDebtUsdMicros(meterSubjects),
    getRemainingPlanDiscountUsdMicros({
      clientId,
      externalUserId,
    }).catch(() => 0n),
  ]);

  return {
    usdMicros: netBillableMeterDebtUsdMicros({
      meterUsdMicros: meter,
      remainingIncludedUsdMicros: remainingIncluded,
    }),
    source: "meter_estimate",
  };
}

export async function getUnbilledDebtUsdMicros(input: {
  clientId: string;
  externalUserId: string;
}): Promise<bigint> {
  return (await getUnbilledDebtDetails(input)).usdMicros;
}
