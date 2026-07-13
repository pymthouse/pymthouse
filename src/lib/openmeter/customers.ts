import type { OpenMeter } from "@openmeter/sdk";
import { getHostedOpenMeterUrl } from "./constants";
import { isOpenMeterUlid } from "./konnect-routes";
import { shouldUseKonnectRoutes } from "./route-mode";

export type OpenMeterCustomerIdentity = {
  id: string;
  key: string;
};

type OpenMeterCustomerRecord = {
  id: string;
  key?: string;
  name?: string;
  usageAttribution?: { subjectKeys?: string[] };
};

async function ensureCustomerUsageAttribution(
  client: OpenMeter,
  customer: OpenMeterCustomerRecord,
  customerKey: string,
): Promise<void> {
  const subjectKeys = customer.usageAttribution?.subjectKeys ?? [];
  if (subjectKeys.includes(customerKey)) {
    return;
  }

  const nextKeys = [...new Set([...subjectKeys, customerKey])];
  await client.customers.update(customer.id, {
    name: customer.name?.trim() || customerKey,
    usageAttribution: { subjectKeys: nextKeys },
  });
}

async function findOpenMeterCustomerByKey(
  client: OpenMeter,
  customerKey: string,
) {
  const apiKey = process.env.OPENMETER_API_KEY?.trim();
  if (shouldUseKonnectRoutes(getHostedOpenMeterUrl(), apiKey) && !isOpenMeterUlid(customerKey)) {
    // customers.list({ key }) is a case-insensitive partial match, so the first
    // item is not guaranteed to be ours — require an exact key match.
    const listed = await client.customers.list({ key: customerKey, page: 1, pageSize: 100 });
    return listed?.items?.find((item) => item.key === customerKey) ?? null;
  }

  try {
    return await client.customers.get(customerKey);
  } catch {
    return null;
  }
}

export async function ensureOpenMeterCustomer(
  client: OpenMeter,
  customerKey: string,
  displayName?: string,
): Promise<OpenMeterCustomerIdentity> {
  const existing = await findOpenMeterCustomerByKey(client, customerKey);
  if (existing?.id) {
    await ensureCustomerUsageAttribution(client, existing, customerKey);
    return { id: existing.id, key: customerKey };
  }

  try {
    const created = await client.customers.create({
      key: customerKey,
      name: displayName || customerKey,
      usageAttribution: { subjectKeys: [customerKey] },
    });
    if (!created?.id) {
      throw new Error(`OpenMeter customer create failed for key ${customerKey}`);
    }
    return { id: created.id, key: customerKey };
  } catch (err) {
    const raced = await findOpenMeterCustomerByKey(client, customerKey);
    if (raced?.id) {
      await ensureCustomerUsageAttribution(client, raced, customerKey);
      return { id: raced.id, key: customerKey };
    }
    throw err;
  }
}

export async function ensureOpenMeterCustomerForAppUser(input: {
  client: OpenMeter;
  clientId: string;
  externalUserId: string;
  displayName?: string;
}): Promise<OpenMeterCustomerIdentity> {
  const { resolveOpenMeterBillingIdentity } = await import(
    "@/lib/openmeter/billing-identity"
  );
  const identity = await resolveOpenMeterBillingIdentity({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });
  return ensureOpenMeterCustomer(
    input.client,
    identity.customerKey,
    input.displayName,
  );
}

export async function assignCustomerBillingProfileOverride(input: {
  client: OpenMeter;
  customerId: string;
  billingProfileId: string;
}): Promise<void> {
  await input.client.billing.customers.createOverride(input.customerId, {
    billingProfileId: input.billingProfileId,
  });
}

export async function listTenantCustomers(
  client: OpenMeter,
  clientId: string,
): Promise<Array<{ id: string; key: string }>> {
  const rows: Array<{ id: string; key: string }> = [];
  let page = 1;
  const pageSize = 100;
  const keyPrefix = `${clientId}:`;

  for (;;) {
    const result = await client.customers.list({
      key: keyPrefix,
      page,
      pageSize,
    });
    const items = result?.items ?? [];
    for (const item of items) {
      if (item.id && item.key?.startsWith(keyPrefix)) {
        rows.push({ id: item.id, key: item.key });
      }
    }
    if (!result || items.length < pageSize) {
      break;
    }
    page += 1;
  }

  return rows;
}

export async function listTenantCustomerIds(
  client: OpenMeter,
  clientId: string,
): Promise<string[]> {
  const rows = await listTenantCustomers(client, clientId);
  return rows.map((row) => row.id);
}
