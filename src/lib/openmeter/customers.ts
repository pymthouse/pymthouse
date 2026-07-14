import { eq } from "drizzle-orm";
import type { OpenMeter } from "@openmeter/sdk";

import { db } from "@/db/index";
import { developerApps, oidcClients } from "@/db/schema";
import {
  buildOpenMeterCustomerKey,
  buildOwnerCustomerKey,
} from "@/lib/openmeter/customer-key";
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

function isActiveSubscriptionSubjectKeyError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    /cannot change subject keys/i.test(message) &&
    /active subscriptions/i.test(message)
  );
}

async function ensureCustomerUsageAttribution(
  client: OpenMeter,
  customer: OpenMeterCustomerRecord,
  requiredSubjectKeys: string[],
): Promise<void> {
  const subjectKeys = customer.usageAttribution?.subjectKeys ?? [];
  const missing = requiredSubjectKeys.filter((key) => !subjectKeys.includes(key));
  if (missing.length === 0) {
    return;
  }

  const nextKeys = [...new Set([...subjectKeys, ...requiredSubjectKeys])];
  try {
    await client.customers.update(customer.id, {
      name: customer.name?.trim() || customer.key || requiredSubjectKeys[0],
      usageAttribution: { subjectKeys: nextKeys },
    });
  } catch (err) {
    // Konnect rejects subject-key changes while a subscription is active.
    // Owner settlement uses CloudEvent subject = owner:{id} (customer key),
    // so mint/provision must not fail closed on this.
    if (isActiveSubscriptionSubjectKeyError(err)) {
      console.warn(
        "openmeter: skip subject key update (active subscription)",
        customer.key ?? customer.id,
        missing.join(","),
      );
      return;
    }
    throw err;
  }
}

/**
 * Ensure the shared owner Konnect customer exists. Compound wire subjects are
 * best-effort — Konnect blocks subject-key changes with active subscriptions.
 */
export async function ensureOwnerCustomerWireSubjects(
  client: OpenMeter,
  ownerUserId: string,
  publicClientIds: string[],
): Promise<OpenMeterCustomerIdentity> {
  const trimmedOwnerId = ownerUserId.trim();
  const ownerKey = buildOwnerCustomerKey(trimmedOwnerId);
  const wireKeys = publicClientIds
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
    .map((clientId) => buildOpenMeterCustomerKey(clientId, trimmedOwnerId));
  const requiredKeys = [...new Set([ownerKey, ...wireKeys])];

  const customer = await ensureOpenMeterCustomer(client, ownerKey);
  const existing = await findOpenMeterCustomerByKey(client, ownerKey);
  if (existing?.id) {
    await ensureCustomerUsageAttribution(client, existing, requiredKeys);
  }
  return customer;
}

export async function listOwnedPublicClientIds(ownerUserId: string): Promise<string[]> {
  const rows = await db
    .select({
      publicClientId: oidcClients.clientId,
      developerAppId: developerApps.id,
    })
    .from(developerApps)
    .leftJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(eq(developerApps.ownerId, ownerUserId.trim()));

  return [
    ...new Set(
      rows
        .map((row) => row.publicClientId?.trim() || row.developerAppId)
        .filter((id): id is string => Boolean(id?.trim())),
    ),
  ];
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
    await ensureCustomerUsageAttribution(client, existing, [customerKey]);
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
      await ensureCustomerUsageAttribution(client, raced, [customerKey]);
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
  if (identity.isOwner && identity.ownerUserId) {
    const ownedClientIds = await listOwnedPublicClientIds(identity.ownerUserId);
    const publicClientIds = [
      ...new Set([identity.publicClientId, ...ownedClientIds]),
    ];
    return ensureOwnerCustomerWireSubjects(
      input.client,
      identity.ownerUserId,
      publicClientIds,
    );
  }
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
