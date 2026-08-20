import type { OpenMeter } from "@openmeter/sdk";
import { eq } from "drizzle-orm";

import { db } from "@/db/index";
import { developerApps, oidcClients } from "@/db/schema";
import {
  classifyInvoiceLineKind,
  type InvoiceLineSummary,
} from "@/lib/billing/invoice-line-labels";
import { resolveAppUserOpenMeterLookupKeys } from "@/lib/openmeter/billing-identity";
import {
  buildOwnerCustomerKey,
  buildOwnerWireSubject,
} from "@/lib/openmeter/customer-key";
import {
  findOpenMeterCustomerByKey,
  listTenantCustomerIds,
} from "./customers";

/**
 * Invoice line rounding policy:
 * Network fees are ingested as exact fractional USD micros. When building
 * merchant-facing invoice line totals (cents), round **up** to the next cent
 * via {@link ceilUsdMicrosToCents} from `@/lib/format-usd-micros` so merchants
 * are never under-billed on dust. OpenMeter/Konnect invoice `totals` returned
 * here are already settled by the billing engine — do not re-round them on read.
 */
export { ceilUsdMicrosToCents } from "@/lib/format-usd-micros";

export type TenantInvoiceDto = {
  id: string;
  number?: string;
  status: string;
  currency: string;
  totalAmount: string;
  customerId?: string;
  customerKey?: string;
  issuedAt?: string;
  periodStart?: string;
  periodEnd?: string;
  /**
   * Stripe invoice id from the invoicing app, when installed. The hosted
   * invoice URL is signed and is not returned here — resolve it on demand
   * via `retrievePlatformInvoiceLinks`.
   */
  externalInvoicingId?: string;
  /** OpenMeter invoice type (`standard` | `credit_note`). */
  invoiceType?: string;
  /** Expanded charge lines when `expand=lines` is available. */
  lines?: InvoiceLineSummary[];
};

type OmInvoiceLineLike = {
  id?: string;
  name?: string;
  description?: string;
  type?: string;
  category?: string;
  managedBy?: string;
  totals?: { total?: string | number | null } | null;
  period?: { from?: Date | string | null; to?: Date | string | null } | null;
  children?: OmInvoiceLineLike[] | null;
};

function periodIso(
  value: Date | string | null | undefined,
): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function mapOmLineToSummary(
  line: OmInvoiceLineLike,
  fallbackId: string,
): InvoiceLineSummary {
  const id = typeof line.id === "string" && line.id.trim() ? line.id : fallbackId;
  const name =
    typeof line.name === "string" && line.name.trim()
      ? line.name.trim()
      : "Charge";
  return {
    id,
    name,
    description:
      typeof line.description === "string" ? line.description : undefined,
    totalAmount: String(line.totals?.total ?? "0"),
    kind: classifyInvoiceLineKind({
      name,
      description: line.description,
      type: line.type,
      category: line.category,
      managedBy: line.managedBy,
    }),
    periodStart: periodIso(line.period?.from ?? null),
    periodEnd: periodIso(line.period?.to ?? null),
  };
}

/**
 * Flatten OpenMeter invoice lines: prefer detailed `children` (flat fees /
 * proration) when present, otherwise the parent usage-based line.
 */
export function mapOpenMeterInvoiceLines(
  rawLines: unknown,
): InvoiceLineSummary[] {
  if (!Array.isArray(rawLines)) return [];
  const out: InvoiceLineSummary[] = [];
  let index = 0;
  for (const raw of rawLines) {
    if (!raw || typeof raw !== "object") continue;
    const line = raw as OmInvoiceLineLike;
    const children = Array.isArray(line.children) ? line.children : [];
    if (children.length > 0) {
      for (const child of children) {
        if (!child || typeof child !== "object") continue;
        out.push(mapOmLineToSummary(child, `line-${index}`));
        index += 1;
      }
      continue;
    }
    out.push(mapOmLineToSummary(line, `line-${index}`));
    index += 1;
  }
  return out;
}

function invoiceScalarString(value: unknown, fallback: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

function mapInvoiceRecord(inv: {
  id: string;
  number?: string | null;
  status?: unknown;
  currency?: unknown;
  totals?: { total?: unknown } | null;
  customer?: { id?: string; key?: string } | null;
  issuedAt?: Date | null;
  period?: { from?: Date | null; to?: Date | null } | null;
  externalIds?: { invoicing?: string | null } | null;
  type?: unknown;
  lines?: unknown;
}): TenantInvoiceDto {
  const invoiceType =
    inv.type == null ? undefined : invoiceScalarString(inv.type, "");
  return {
    id: inv.id,
    number: inv.number ?? undefined,
    status: invoiceScalarString(inv.status, "unknown"),
    currency: invoiceScalarString(inv.currency, "USD"),
    totalAmount: invoiceScalarString(inv.totals?.total, "0"),
    customerId: inv.customer?.id,
    customerKey: inv.customer?.key,
    issuedAt: inv.issuedAt?.toISOString?.() ?? undefined,
    periodStart: inv.period?.from?.toISOString?.() ?? undefined,
    periodEnd: inv.period?.to?.toISOString?.() ?? undefined,
    externalInvoicingId: inv.externalIds?.invoicing ?? undefined,
    invoiceType: invoiceType || undefined,
    lines: mapOpenMeterInvoiceLines(inv.lines),
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function findCustomerIdByExactKey(
  client: OpenMeter,
  customerKey: string,
): Promise<string | null> {
  try {
    const listed = await client.customers.list({
      key: customerKey,
      page: 1,
      pageSize: 50,
    });
    const match = (listed?.items ?? []).find((item) => item.key === customerKey);
    return match?.id ?? null;
  } catch {
    return null;
  }
}

async function resolveOwnerCustomerIdsByUserId(
  client: OpenMeter,
  ownerUserId: string,
): Promise<string[]> {
  const ownerId = ownerUserId.trim();
  if (!ownerId) return [];

  const keys = [
    buildOwnerCustomerKey(ownerId),
    buildOwnerWireSubject(ownerId),
  ];
  const ids = await Promise.all(
    keys.map((key) => findCustomerIdByExactKey(client, key)),
  );
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}

async function resolveOwnerCustomerIdsForApp(
  client: OpenMeter,
  clientId: string,
): Promise<string[]> {
  const trimmed = clientId.trim();
  if (!trimmed) return [];

  let ownerId: string | undefined;
  try {
    const byPublic = await db
      .select({ ownerId: developerApps.ownerId })
      .from(developerApps)
      .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
      .where(eq(oidcClients.clientId, trimmed))
      .limit(1);
    ownerId = byPublic[0]?.ownerId?.trim();
    if (!ownerId) {
      const byApp = await db
        .select({ ownerId: developerApps.ownerId })
        .from(developerApps)
        .where(eq(developerApps.id, trimmed))
        .limit(1);
      ownerId = byApp[0]?.ownerId?.trim();
    }
  } catch {
    return [];
  }
  if (!ownerId) return [];
  return resolveOwnerCustomerIdsByUserId(client, ownerId);
}

async function listInvoicesForCustomerIds(input: {
  client: OpenMeter;
  customerIds: string[];
  page: number;
  pageSize: number;
}): Promise<{ items: TenantInvoiceDto[]; page: number; pageSize: number; totalCount: number }> {
  const { client, customerIds, page, pageSize } = input;
  if (customerIds.length === 0) {
    return { items: [], page, pageSize, totalCount: 0 };
  }

  const allItems: TenantInvoiceDto[] = [];
  for (const idChunk of chunk(customerIds, 50)) {
    const result = await client.billing.invoices.list({
      customers: idChunk,
      page: 1,
      pageSize: 100,
      order: "DESC",
      orderBy: "createdAt",
      expand: ["lines"],
    });
    for (const inv of result?.items ?? []) {
      allItems.push(mapInvoiceRecord(inv));
    }
  }

  allItems.sort((a, b) => (b.issuedAt ?? "").localeCompare(a.issuedAt ?? ""));
  const totalCount = allItems.length;
  const offset = (page - 1) * pageSize;
  const items = allItems.slice(offset, offset + pageSize);

  return { items, page, pageSize, totalCount };
}

/**
 * Merchant invoices for an app's end users (`{publicClientId}:{externalUserId}`).
 *
 * `clientId` must be the public OIDC `app_…` client id (not developer_apps.id).
 * Owner-wallet invoices (platform → developer) belong on `/billing`, not here —
 * pass `includeOwnerWallet: true` only for legacy/admin mixed views.
 */
export async function listTenantInvoices(input: {
  client: OpenMeter;
  clientId: string;
  page?: number;
  pageSize?: number;
  /** When true, also include the app owner's shared wallet invoices. Default false. */
  includeOwnerWallet?: boolean;
}): Promise<{ items: TenantInvoiceDto[]; page: number; pageSize: number; totalCount: number }> {
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? 20;
  const endUserIds = await listTenantCustomerIds(input.client, input.clientId);
  const ownerIds = input.includeOwnerWallet
    ? await resolveOwnerCustomerIdsForApp(input.client, input.clientId)
    : [];
  const customerIds = [...new Set([...endUserIds, ...ownerIds])];
  return listInvoicesForCustomerIds({
    client: input.client,
    customerIds,
    page,
    pageSize,
  });
}

/** Platform invoices for a developer owner's shared prepaid wallet. */
export async function listOwnerWalletInvoices(input: {
  client: OpenMeter;
  ownerUserId: string;
  page?: number;
  pageSize?: number;
}): Promise<{ items: TenantInvoiceDto[]; page: number; pageSize: number; totalCount: number }> {
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? 20;
  const customerIds = await resolveOwnerCustomerIdsByUserId(
    input.client,
    input.ownerUserId,
  );
  return listInvoicesForCustomerIds({
    client: input.client,
    customerIds,
    page,
    pageSize,
  });
}

async function findInvoiceInCustomerChunk(input: {
  client: OpenMeter;
  customers: string[];
  allowedCustomerIds: string[];
  invoiceId: string;
}): Promise<TenantInvoiceDto | null | undefined> {
  let page = 1;
  for (;;) {
    let result: Awaited<ReturnType<typeof input.client.billing.invoices.list>>;
    try {
      result = await input.client.billing.invoices.list({
        customers: input.customers,
        page,
        pageSize: 100,
        order: "DESC",
        orderBy: "createdAt",
        expand: ["lines"],
      });
    } catch {
      return null;
    }
    const items = result?.items ?? [];
    const match = items.find((inv) => inv.id === input.invoiceId);
    if (match?.id) {
      const invoiceCustomerId = match.customer?.id?.trim();
      if (
        invoiceCustomerId &&
        input.allowedCustomerIds.includes(invoiceCustomerId)
      ) {
        return mapInvoiceRecord(match);
      }
      return null;
    }
    if (items.length < 100 || page >= 50) return undefined;
    page += 1;
  }
}

/**
 * Fetch one platform invoice by id, only when it belongs to the owner's wallet
 * customers. Avoids the page-size cap on {@link listOwnerWalletInvoices}.
 */
export async function getOwnerWalletInvoice(input: {
  client: OpenMeter;
  ownerUserId: string;
  invoiceId: string;
}): Promise<TenantInvoiceDto | null> {
  const invoiceId = input.invoiceId.trim();
  if (!invoiceId) return null;

  const customerIds = await resolveOwnerCustomerIdsByUserId(
    input.client,
    input.ownerUserId,
  );
  if (customerIds.length === 0) return null;

  for (const idChunk of chunk(customerIds, 50)) {
    const found = await findInvoiceInCustomerChunk({
      client: input.client,
      customers: idChunk,
      allowedCustomerIds: customerIds,
      invoiceId,
    });
    if (found !== undefined) return found;
  }

  return null;
}

/**
 * Lookup-only end-user customer for invoice/PM reads.
 * Uses the billing identity (`eu_…` live, `sbx_eu_…` sandbox) and dual-reads
 * the legacy compound key. Never the owner wallet on owner_rollup.
 */
async function lookupAppUserCustomer(input: {
  client: OpenMeter;
  clientId: string;
  externalUserId: string;
}): Promise<{ id: string; key: string } | null> {
  const externalUserId = input.externalUserId.trim();
  if (!input.clientId.trim() || !externalUserId) {
    return null;
  }
  const keys = await resolveAppUserOpenMeterLookupKeys({
    clientId: input.clientId,
    externalUserId,
  });
  for (const key of keys) {
    const existing = await findOpenMeterCustomerByKey(input.client, key);
    const id = existing?.id?.trim();
    if (id) {
      return { id, key };
    }
  }
  return null;
}

/**
 * End-user invoices for one app user (identity customer, plus legacy compound).
 * Lookup-only — does not create customers or resolve owner wallets.
 */
export async function listAppUserInvoices(input: {
  client: OpenMeter;
  clientId: string;
  externalUserId: string;
  page?: number;
  pageSize?: number;
}): Promise<{
  items: TenantInvoiceDto[];
  page: number;
  pageSize: number;
  totalCount: number;
}> {
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? 20;
  const clientId = input.clientId.trim();
  const externalUserId = input.externalUserId.trim();
  if (!clientId || !externalUserId) {
    return { items: [], page, pageSize, totalCount: 0 };
  }

  const customer = await lookupAppUserCustomer({
    client: input.client,
    clientId,
    externalUserId,
  });
  if (!customer) {
    return { items: [], page, pageSize, totalCount: 0 };
  }

  return listInvoicesForCustomerIds({
    client: input.client,
    customerIds: [customer.id],
    page,
    pageSize,
  });
}

/**
 * Fetch one invoice by id, only when it belongs to this app user's customer.
 * Lookup-only — does not create customers or resolve owner wallets.
 */
export async function getAppUserInvoice(input: {
  client: OpenMeter;
  clientId: string;
  externalUserId: string;
  invoiceId: string;
}): Promise<TenantInvoiceDto | null> {
  const invoiceId = input.invoiceId.trim();
  const clientId = input.clientId.trim();
  const externalUserId = input.externalUserId.trim();
  if (!invoiceId || !clientId || !externalUserId) return null;

  const customer = await lookupAppUserCustomer({
    client: input.client,
    clientId,
    externalUserId,
  });
  if (!customer) return null;

  const customerIds = [customer.id];
  for (const idChunk of chunk(customerIds, 50)) {
    const found = await findInvoiceInCustomerChunk({
      client: input.client,
      customers: idChunk,
      allowedCustomerIds: customerIds,
      invoiceId,
    });
    if (found !== undefined) return found;
  }

  return null;
}
