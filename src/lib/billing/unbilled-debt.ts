/**
 * Resolve unbilled debt (USD micros) for soft-negative gating / invoice trigger.
 * Prefer OpenMeter invoice totals (gathering + unpaid open); fall back to
 * calendar-month meter usage only when the invoice list fails.
 */
import { calendarMonthBoundsUtc } from "@/lib/billing-utils";
import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "@/lib/openmeter/admin-client";
import {
  ownerCostRailUserId,
  resolveOpenMeterBillingIdentity,
} from "@/lib/openmeter/billing-identity";
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

type InvoiceDebtRow = {
  status?: string | null;
  customer?: { id?: string | null } | null;
  customerId?: string | null;
  customer_id?: string | null;
  totals?: { total?: unknown } | null;
};

function invoiceCustomerId(inv: InvoiceDebtRow): string | null {
  return (
    inv.customer?.id?.trim() ||
    (typeof inv.customerId === "string" ? inv.customerId.trim() : null) ||
    (typeof inv.customer_id === "string" ? inv.customer_id.trim() : null) ||
    null
  );
}

function statusRoot(status: string): string {
  const lower = status.toLowerCase();
  const dot = lower.indexOf(".");
  return dot >= 0 ? lower.slice(0, dot) : lower;
}

function isPaidOrClosedStatus(status: string): boolean {
  const root = statusRoot(status);
  return (
    root === "paid" ||
    root === "void" ||
    root === "uncollectible" ||
    root === "deleted"
  );
}

function isUnpaidOpenStatus(status: string): boolean {
  const root = statusRoot(status);
  return (
    root === "draft" ||
    root === "issuing" ||
    root === "issued" ||
    root === "payment_processing" ||
    root === "overdue"
  );
}

function invoiceDebtContribution(
  inv: InvoiceDebtRow,
  customerId: string,
): { kind: "gathering" | "unpaid"; micros: bigint } | null {
  const invCustomer = invoiceCustomerId(inv);
  if (invCustomer && invCustomer !== customerId) {
    return null;
  }
  const status = String(inv.status ?? "").trim();
  if (!status) return null;
  const micros = gatheringTotalUsdMicros(inv.totals?.total);
  if (micros == null) return null;

  const root = statusRoot(status);
  if (root === "gathering") {
    return { kind: "gathering", micros };
  }
  if (isPaidOrClosedStatus(status) || !isUnpaidOpenStatus(status)) {
    return null;
  }
  return { kind: "unpaid", micros };
}

/**
 * Debt from a successful invoice list: max gathering total + sum of unpaid
 * open invoices (draft/issued/overdue/…). Paid/void are excluded. Empty list
 * is 0 — do not fall through to meter.
 */
export function unbilledInvoiceDebtFromItems(
  items: InvoiceDebtRow[],
  customerId: string,
): bigint {
  let gatheringMax = 0n;
  let hasGathering = false;
  let unpaidOpenSum = 0n;

  for (const inv of items) {
    const contrib = invoiceDebtContribution(inv, customerId);
    if (!contrib) continue;
    if (contrib.kind === "gathering") {
      hasGathering = true;
      if (contrib.micros > gatheringMax) gatheringMax = contrib.micros;
      continue;
    }
    unpaidOpenSum += contrib.micros;
  }

  return (hasGathering ? gatheringMax : 0n) + unpaidOpenSum;
}

/**
 * Konnect `customers` list filter is often ignored on `/v3/openmeter`. Prefer
 * `/metering/v1` with an explicit customer filter, then client-side match.
 */
async function listInvoicesViaMeteringV1(
  customerId: string,
): Promise<InvoiceDebtRow[] | null> {
  try {
    const params = new URLSearchParams();
    params.set("filter[customer.id][eq]", customerId);
    params.set("page[size]", "50");
    params.set("page[number]", "1");
    const listed = await konnectMeteringV1Fetch<{
      items?: InvoiceDebtRow[];
      data?: InvoiceDebtRow[];
    }>(`/billing/invoices?${params.toString()}`, { method: "GET" }, "unbilled-invoices");
    return listed?.items ?? listed?.data ?? [];
  } catch {
    try {
      const params = new URLSearchParams();
      params.set("filter[customer_id][eq]", customerId);
      params.set("page[size]", "50");
      const listed = await konnectMeteringV1Fetch<{
        items?: InvoiceDebtRow[];
        data?: InvoiceDebtRow[];
      }>(
        `/billing/invoices?${params.toString()}`,
        { method: "GET" },
        "unbilled-invoices",
      );
      return listed?.items ?? listed?.data ?? [];
    } catch {
      return null;
    }
  }
}

type InvoiceDebtLookup =
  | { ok: true; usdMicros: bigint }
  | { ok: false };

async function lookupUnbilledInvoiceDebt(
  customerId: string,
): Promise<InvoiceDebtLookup> {
  if (!isHostedAdminClientAvailable()) {
    return { ok: false };
  }

  const openmeterUrl = getHostedOpenMeterUrl();
  if (isKonnectMeteringUrl(openmeterUrl)) {
    const viaMetering = await listInvoicesViaMeteringV1(customerId);
    if (viaMetering != null) {
      return {
        ok: true,
        usdMicros: unbilledInvoiceDebtFromItems(viaMetering, customerId),
      };
    }
  }

  try {
    const client = getHostedAdminClient();
    const listed = await client.billing.invoices.list({
      customers: [customerId],
      page: 1,
      pageSize: 50,
      order: "DESC",
      orderBy: "createdAt",
    });
    return {
      ok: true,
      usdMicros: unbilledInvoiceDebtFromItems(listed?.items ?? [], customerId),
    };
  } catch {
    return { ok: false };
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

  const ownerUserId = ownerCostRailUserId(identity);
  if (ownerUserId) {
    const publicClientIds = await listOwnedPublicClientIds(ownerUserId);
    const ownerCustomer = await ensureOwnerCustomer(
      client,
      ownerUserId,
      publicClientIds,
    );
    return {
      customerId: ownerCustomer.id?.trim() || null,
      meterSubjects: buildOwnerMeterSubjects(ownerUserId, [
        identity.publicClientId,
        ...publicClientIds,
      ]),
    };
  }

  await ensureOpenMeterCustomer(client, identity.payerCustomerKey);
  const customer = await findOpenMeterCustomerByKey(
    client,
    identity.payerCustomerKey,
  );
  const meterSubjects = [
    identity.payerCustomerKey,
    ...(identity.legacyCompoundCustomerKey
      ? [identity.legacyCompoundCustomerKey]
      : []),
  ];
  return {
    customerId: customer?.id?.trim() || null,
    meterSubjects: [...new Set(meterSubjects)],
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
 * Unbilled debt for soft-negative gating. Invoice totals when the list
 * succeeds (including 0 when gathering is empty / only paid remain); else
 * period network-fee meter sum net of remaining included usage.
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
    const looked = await lookupUnbilledInvoiceDebt(customerId);
    if (looked.ok) {
      return { usdMicros: looked.usdMicros, source: "gathering_invoice" };
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
