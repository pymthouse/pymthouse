import type { OpenMeter } from "@openmeter/sdk";
import { getHostedOpenMeterUrl } from "./constants";
import { buildOpenMeterCustomerKey } from "./customer-key";
import { isOpenMeterUlid } from "./konnect-routes";
import { shouldUseKonnectRoutes } from "./route-mode";

export type OpenMeterCustomerIdentity = {
  id: string;
  key: string;
};

async function findOpenMeterCustomerByKey(
  client: OpenMeter,
  customerKey: string,
) {
  const apiKey = process.env.OPENMETER_API_KEY?.trim();
  if (shouldUseKonnectRoutes(getHostedOpenMeterUrl(), apiKey) && !isOpenMeterUlid(customerKey)) {
    const listed = await client.customers.list({ key: customerKey, page: 1, pageSize: 1 });
    return listed?.items?.[0] ?? null;
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
    return { id: existing.id, key: customerKey };
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
