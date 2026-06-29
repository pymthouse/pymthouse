import type { OpenMeter } from "@openmeter/sdk";
import { getHostedOpenMeterUrl } from "./constants";
import { buildOpenMeterCustomerKey, parseOpenMeterCustomerKey } from "./customer-key";
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
  subjectKeys: string[],
): Promise<void> {
  const existing = customer.usageAttribution?.subjectKeys ?? [];
  const nextKeys = [...new Set([...existing, ...subjectKeys])];
  if (nextKeys.length === existing.length) {
    return;
  }

  await client.customers.update(customer.id, {
    name: customer.name?.trim() || customer.key || nextKeys[0],
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
  subjectKey?: string,
): Promise<OpenMeterCustomerIdentity> {
  // Normalized CloudEvents set `subject` to the bare usage_subject (end user),
  // while the customer key stays compound (client_id:user) as the tenant-scoped
  // identity. Attribute usage by both the bare subject (new events) and the
  // compound key (already-ingested historical events) so balances stay continuous.
  const usageSubject =
    subjectKey?.trim() || parseOpenMeterCustomerKey(customerKey)?.externalUserId || customerKey;
  const subjectKeys = [...new Set([usageSubject, customerKey])];

  const existing = await findOpenMeterCustomerByKey(client, customerKey);
  if (existing?.id) {
    await ensureCustomerUsageAttribution(client, existing, subjectKeys);
    return { id: existing.id, key: customerKey };
  }

  try {
    const created = await client.customers.create({
      key: customerKey,
      name: displayName || customerKey,
      usageAttribution: { subjectKeys },
    });
    if (!created?.id) {
      throw new Error(`OpenMeter customer create failed for key ${customerKey}`);
    }
    return { id: created.id, key: customerKey };
  } catch (err) {
    const raced = await findOpenMeterCustomerByKey(client, customerKey);
    if (raced?.id) {
      await ensureCustomerUsageAttribution(client, raced, subjectKeys);
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
  const key = buildOpenMeterCustomerKey(input.clientId, input.externalUserId);
  return ensureOpenMeterCustomer(input.client, key, input.displayName, input.externalUserId);
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
