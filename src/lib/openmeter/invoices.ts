import type { OpenMeter } from "@openmeter/sdk";
import { listTenantCustomerIds } from "./customers";

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

export async function listTenantInvoices(input: {
  client: OpenMeter;
  clientId: string;
  page?: number;
  pageSize?: number;
}): Promise<{ items: TenantInvoiceDto[]; page: number; pageSize: number; totalCount: number }> {
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? 20;
  const customerIds = await listTenantCustomerIds(input.client, input.clientId);

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
