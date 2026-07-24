import type { OpenMeter } from "@openmeter/sdk";
import { eq } from "drizzle-orm";

import { db } from "@/db/index";
import { developerApps, oidcClients } from "@/db/schema";
import {
  buildOwnerCustomerKey,
  buildOwnerWireSubject,
} from "@/lib/openmeter/customer-key";
import { listTenantCustomerIds } from "./customers";

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
};

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

  const keys = [
    buildOwnerCustomerKey(ownerId),
    buildOwnerWireSubject(ownerId),
  ];
  const ids: string[] = [];
  for (const key of keys) {
    const id = await findCustomerIdByExactKey(client, key);
    if (id) ids.push(id);
  }
  return [...new Set(ids)];
}

export async function listTenantInvoices(input: {
  client: OpenMeter;
  clientId: string;
  page?: number;
  pageSize?: number;
  /** When true (default), also include the app owner's shared wallet invoices. */
  includeOwnerWallet?: boolean;
}): Promise<{ items: TenantInvoiceDto[]; page: number; pageSize: number; totalCount: number }> {
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? 20;
  const endUserIds = await listTenantCustomerIds(input.client, input.clientId);
  const ownerIds =
    input.includeOwnerWallet === false
      ? []
      : await resolveOwnerCustomerIdsForApp(input.client, input.clientId);
  const customerIds = [...new Set([...endUserIds, ...ownerIds])];

  if (customerIds.length === 0) {
    return { items: [], page, pageSize, totalCount: 0 };
  }

  const allItems: TenantInvoiceDto[] = [];
  for (const idChunk of chunk(customerIds, 50)) {
    const result = await input.client.billing.invoices.list({
      customers: idChunk,
      page: 1,
      pageSize: 100,
      order: "DESC",
      orderBy: "createdAt",
    });
    for (const inv of result?.items ?? []) {
      allItems.push({
        id: inv.id,
        number: inv.number ?? undefined,
        status: String(inv.status ?? "unknown"),
        currency: String(inv.currency ?? "USD"),
        totalAmount: String(inv.totals?.total ?? "0"),
        customerId: inv.customer?.id,
        customerKey: inv.customer?.key,
        issuedAt: inv.issuedAt?.toISOString?.() ?? undefined,
        periodStart: inv.period?.from?.toISOString?.() ?? undefined,
        periodEnd: inv.period?.to?.toISOString?.() ?? undefined,
      });
    }
  }

  allItems.sort((a, b) => (b.issuedAt ?? "").localeCompare(a.issuedAt ?? ""));
  const totalCount = allItems.length;
  const offset = (page - 1) * pageSize;
  const items = allItems.slice(offset, offset + pageSize);

  return { items, page, pageSize, totalCount };
}
