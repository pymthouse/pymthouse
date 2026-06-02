import type { OpenMeter } from "@openmeter/sdk";
import { buildOpenMeterCustomerKey } from "./customer-key";

export type OpenMeterCustomerIdentity = {
  id: string;
  key: string;
};

export async function ensureOpenMeterCustomer(
  client: OpenMeter,
  customerKey: string,
  displayName?: string,
): Promise<OpenMeterCustomerIdentity> {
  try {
    const existing = await client.customers.get(customerKey);
    if (existing?.id) {
      return { id: existing.id, key: customerKey };
    }
  } catch {
    /* create below */
  }

  const created = await client.customers.create({
    key: customerKey,
    name: displayName || customerKey,
    usageAttribution: { subjectKeys: [customerKey] },
  });
  if (!created?.id) {
    throw new Error(`OpenMeter customer create failed for key ${customerKey}`);
  }
  return { id: created.id, key: customerKey };
}

export async function ensureOpenMeterCustomerForAppUser(input: {
  client: OpenMeter;
  clientId: string;
  externalUserId: string;
  displayName?: string;
}): Promise<OpenMeterCustomerIdentity> {
  const key = buildOpenMeterCustomerKey(input.clientId, input.externalUserId);
  return ensureOpenMeterCustomer(input.client, key, input.displayName);
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

export async function listTenantCustomerIds(
  client: OpenMeter,
  clientId: string,
): Promise<string[]> {
  const ids: string[] = [];
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
        ids.push(item.id);
      }
    }
    if (!result || items.length < pageSize) {
      break;
    }
    page += 1;
  }

  return ids;
}
