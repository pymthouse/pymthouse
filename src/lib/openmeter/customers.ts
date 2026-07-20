import { eq } from "drizzle-orm";
import type { OpenMeter } from "@openmeter/sdk";

import { db } from "@/db/index";
import { developerApps, oidcClients } from "@/db/schema";
import {
  buildOwnerCustomerKey,
  buildOwnerMeterSubjects,
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
  metadata?: Record<string, string> | null;
  usageAttribution?: { subjectKeys?: string[] };
};

function isActiveSubscriptionSubjectKeyError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    /cannot change subject keys/i.test(message) &&
    /active subscriptions/i.test(message)
  );
}

function isSubjectKeyConflictError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    /subject keys?/i.test(message) &&
    (/already associated/i.test(message) || /conflict/i.test(message))
  );
}

/** Statuses that lock subject-key edits on Konnect (mirrors subscription-read). */
function isSubjectKeyLockingSubscriptionStatus(status: string | undefined): boolean {
  return status === "active" || status === "scheduled" || status === "pending";
}

/**
 * True when the customer has a subscription that blocks subject-key changes.
 * Local check (no subscription-read import) to avoid a customers↔subscription cycle.
 */
async function customerHasSubjectKeyLockingSubscription(
  client: OpenMeter,
  customerId: string,
): Promise<boolean> {
  try {
    const listed = await client.customers.listSubscriptions(customerId, {
      pageSize: 100,
    });
    return (listed?.items ?? []).some((item) =>
      isSubjectKeyLockingSubscriptionStatus(item.status),
    );
  } catch {
    // Fall through to the update attempt; catch still handles the 400.
    return false;
  }
}

async function ensureCustomerUsageAttribution(
  client: OpenMeter,
  customer: OpenMeterCustomerRecord,
  requiredSubjectKeys: string[],
  metadata?: Record<string, string>,
): Promise<void> {
  const subjectKeys = customer.usageAttribution?.subjectKeys ?? [];
  const missing = requiredSubjectKeys.filter((key) => !subjectKeys.includes(key));
  const nextKeys = [...new Set([...subjectKeys, ...requiredSubjectKeys])];
  const nextMetadata = {
    ...customer.metadata,
    ...metadata,
  };
  const metadataChanged =
    metadata != null &&
    Object.entries(metadata).some(
      ([k, v]) => (customer.metadata?.[k] ?? "") !== v,
    );

  if (missing.length === 0 && !metadataChanged) {
    return;
  }

  // Konnect rejects subject-key changes while a subscription is active.
  // Skip the PUT (and the warn) when we already know it will fail; metadata-only
  // updates (missing.length === 0) are still safe and proceed below.
  if (
    missing.length > 0 &&
    (await customerHasSubjectKeyLockingSubscription(client, customer.id))
  ) {
    return;
  }

  try {
    // Konnect customer update is a full replace (PUT) — always send the
    // current subjectKeys so a metadata-only update does not wipe them.
    // nextKeys equals the existing set when nothing is missing (no real
    // change), so this does not trip the active-subscription 400 guard.
    await client.customers.update(customer.id, {
      name: customer.name?.trim() || customer.key || requiredSubjectKeys[0],
      usageAttribution: { subjectKeys: nextKeys },
      ...(Object.keys(nextMetadata).length > 0 ? { metadata: nextMetadata } : {}),
    });
  } catch (err) {
    // Safety net for TOCTOU (sub activated between check and PUT) or when
    // keys are still owned by another customer (legacy owner: wallet).
    if (isActiveSubscriptionSubjectKeyError(err)) {
      return;
    }
    if (isSubjectKeyConflictError(err)) {
      console.warn(
        "openmeter: skip subject key update",
        customer.key ?? customer.id,
        missing.join(","),
        err instanceof Error ? err.message : String(err),
      );
      return;
    }
    throw err;
  }
}

/**
 * Ensure the shared owner Konnect customer exists with bare `{users.id}` key.
 * Attaches transitional subjectKeys (owner: + compound wire forms) at creation
 * time when possible, and stores owned public client ids in metadata.
 *
 * @deprecated Prefer {@link ensureOwnerCustomer}. Kept as an alias for callers.
 */
export async function ensureOwnerCustomerWireSubjects(
  client: OpenMeter,
  ownerUserId: string,
  publicClientIds: string[],
): Promise<OpenMeterCustomerIdentity> {
  return ensureOwnerCustomer(client, ownerUserId, publicClientIds);
}

/**
 * Ensure the shared owner Konnect customer (canonical key = bare users.id).
 * Created with subjectKeys = [bareId] so it does not conflict with a legacy
 * `owner:{id}` customer.
 *
 * For existing customers, only ensure the bare settlement subject is present
 * (+ metadata). Does not strip transitional keys already on the record; it
 * simply avoids attaching more. Transitional wire/compound subjects
 * (`owner:…`, `app_…:…`) are attached best-effort once at create time;
 * Konnect rejects later changes while a subscription is active (400) or when
 * a legacy wallet still claims them (409). Meter dual-read for usage does not
 * require those keys on the customer record.
 */
export async function ensureOwnerCustomer(
  client: OpenMeter,
  ownerUserId: string,
  publicClientIds: string[],
): Promise<OpenMeterCustomerIdentity> {
  const trimmedOwnerId = ownerUserId.trim();
  const ownerKey = buildOwnerCustomerKey(trimmedOwnerId);
  const uniqueClientIds = [
    ...new Set(
      publicClientIds.map((id) => id.trim()).filter((id) => id.length > 0),
    ),
  ];
  // Settlement subject only for existing customers. Transitional keys are
  // create-time best-effort; see buildOwnerMeterSubjects for meter dual-read.
  const settlementKeys = [ownerKey];
  const transitionalKeys = buildOwnerMeterSubjects(
    trimmedOwnerId,
    uniqueClientIds,
  );
  const metadata: Record<string, string> = {
    pymthouse_owner_user_id: trimmedOwnerId,
    pymthouse_owned_client_ids: uniqueClientIds.join(","),
  };

  const existing = await findOpenMeterCustomerByKey(client, ownerKey);
  if (existing?.id) {
    await ensureCustomerUsageAttribution(
      client,
      existing,
      settlementKeys,
      metadata,
    );
    return { id: existing.id, key: ownerKey };
  }

  // Create with bare key only — legacy owner:{id} customers already claim wire subjects.
  try {
    const created = await client.customers.create({
      key: ownerKey,
      name: `Owner ${trimmedOwnerId}`,
      usageAttribution: { subjectKeys: [ownerKey] },
      metadata,
    });
    if (!created?.id) {
      throw new Error(`OpenMeter customer create failed for key ${ownerKey}`);
    }
    // Best-effort: attach transitional subjects before any subscription locks keys.
    const fresh = await findOpenMeterCustomerByKey(client, ownerKey);
    if (fresh?.id) {
      await ensureCustomerUsageAttribution(
        client,
        fresh,
        transitionalKeys,
        metadata,
      );
    }
    return { id: created.id, key: ownerKey };
  } catch (err) {
    const raced = await findOpenMeterCustomerByKey(client, ownerKey);
    if (raced?.id) {
      await ensureCustomerUsageAttribution(
        client,
        raced,
        settlementKeys,
        metadata,
      );
      return { id: raced.id, key: ownerKey };
    }
    throw err;
  }
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

/** Lookup-only (never creates). Exact key match on Konnect; get() elsewhere. */
export async function findOpenMeterCustomerByKey(
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
    return ensureOwnerCustomer(
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
