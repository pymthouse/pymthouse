import { eq } from "drizzle-orm";
import type { OpenMeter } from "@openmeter/sdk";
import { v4 as uuidv4 } from "uuid";

import { db } from "@/db/index";
import { billingCustomers, developerApps, oidcClients } from "@/db/schema";
import { createAsyncTtlCache, resolveCacheTtlSeconds } from "@/lib/async-ttl-cache";
import {
  buildOwnerCustomerKey,
  buildOwnerMeterSubjects,
  isEndUserCustomerKey,
  parseEndUserCustomerKey,
} from "@/lib/openmeter/customer-key";
import { sanitizeForLog } from "@/lib/sanitize-for-log";
import { getHostedOpenMeterUrl } from "./constants";
import { isOpenMeterUlid } from "./konnect-routes";
import { shouldUseKonnectRoutes } from "./route-mode";

export type OpenMeterCustomerIdentity = {
  id: string;
  key: string;
};

/**
 * Customer ensures are idempotent Konnect round-trips (list + attribution
 * check + optional PUT) that the signer hot path repeats several times per
 * request. Remember successful ensures per customer key so warm requests skip
 * the Konnect traffic entirely; the TTL bounds how long an externally deleted
 * customer could be assumed to exist.
 */
let ensuredCustomerCache: ReturnType<
  typeof createAsyncTtlCache<OpenMeterCustomerIdentity>
> | null = null;

function getEnsuredCustomerCache() {
  ensuredCustomerCache ??= createAsyncTtlCache<OpenMeterCustomerIdentity>({
    ttlSeconds: resolveCacheTtlSeconds("OPENMETER_CUSTOMER_ENSURE_CACHE_TTL_SECONDS", 300),
  });
  return ensuredCustomerCache;
}

export function resetEnsuredCustomerCacheForTests(): void {
  ensuredCustomerCache = null;
}

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
        sanitizeForLog(customer.key ?? customer.id),
        sanitizeForLog(missing.join(",")),
        sanitizeForLog(err instanceof Error ? err.message : String(err)),
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
 * a legacy wallet still claims them (409).
 *
 * These keys are what OpenMeter bills over, and since
 * `resolveCustomerSubjectKeys` they are also what PymtHouse reads. A subject
 * missing here is therefore neither invoiced nor displayed —
 * `classifyUsageAttributionConsistency` reports any that still carry usage.
 * (This previously read "meter dual-read for usage does not require those keys
 * on the customer record", which was true of reads and false of billing: usage
 * on an unattributed subject was shown but never charged.)
 */
export async function ensureOwnerCustomer(
  client: OpenMeter,
  ownerUserId: string,
  publicClientIds: string[],
): Promise<OpenMeterCustomerIdentity> {
  // Owner and end-user ensures apply different attribution/metadata for the
  // same customer key, so they cache under distinct namespaces.
  return getEnsuredCustomerCache().get(
    `owner\u0000${buildOwnerCustomerKey(ownerUserId.trim())}`,
    () => ensureOwnerCustomerUncached(client, ownerUserId, publicClientIds),
  );
}

async function ensureOwnerCustomerUncached(
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
  // Neon (`listOwnedPublicClientIds`) is the source of truth for owned apps.
  // Do not write comma-joined client ids into Konnect labels — Kong rejects
  // commas and values over 63 chars (`labels.* [max_length]` / `[pattern]`).
  const metadata: Record<string, string> = {
    pymthouse_owner_user_id: trimmedOwnerId,
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
/**
 * Subjects OpenMeter attributes to a customer — `usageAttribution.subjectKeys`.
 *
 * This is the authority for both billing and reads. OpenMeter's invoicing runs
 * per customer over exactly these subjects, so any usage query that reads a
 * different set will disagree with the invoice it is meant to explain.
 * Reading a *wider* set is the dangerous direction: it shows usage the billing
 * engine will never charge for.
 *
 * Returns [] when the customer cannot be read, so callers can distinguish
 * "no attributed subjects" from "lookup failed" and avoid silently widening.
 *
 * See docs/adr-owner-vs-app-billing.md ("Usage reads follow customer id").
 */
export async function resolveCustomerSubjectKeys(
  client: OpenMeter,
  customerKey: string,
): Promise<string[]> {
  const trimmed = customerKey.trim();
  if (!trimmed) return [];
  try {
    const customer = (await findOpenMeterCustomerByKey(
      client,
      trimmed,
    )) as OpenMeterCustomerRecord | null;
    const keys = customer?.usageAttribution?.subjectKeys ?? [];
    return [...new Set(keys.map((key) => key.trim()).filter(Boolean))];
  } catch (err) {
    console.warn(
      "customers: subject key lookup failed",
      trimmed,
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

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
  return getEnsuredCustomerCache().get(`customer\u0000${customerKey}`, () =>
    ensureOpenMeterCustomerUncached(client, customerKey, displayName),
  );
}

async function ensureOpenMeterCustomerUncached(
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
  const { ownerCostRailUserId, resolveOpenMeterBillingIdentity } = await import(
    "@/lib/openmeter/billing-identity"
  );
  const identity = await resolveOpenMeterBillingIdentity({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });

  // Eagerly ensure the end-user customer (eu_…) so a later merchant switch
  // never needs a subject-key edit under an active subscription.
  if (isEndUserCustomerKey(identity.actorEndUserId)) {
    const endUserCustomer = await ensureOpenMeterCustomer(
      input.client,
      identity.actorEndUserId,
      input.displayName,
    );
    await recordBillingCustomer({
      customerKey: endUserCustomer.key,
      kind: "end_user",
      endUserId: parseEndUserCustomerKey(endUserCustomer.key) ?? undefined,
      clientId: identity.developerAppId,
      openmeterCustomerId: endUserCustomer.id,
    });
  }

  const ownerUserId = ownerCostRailUserId(identity);
  if (ownerUserId) {
    const ownedClientIds = await listOwnedPublicClientIds(ownerUserId);
    const publicClientIds = [
      ...new Set([identity.publicClientId, ...ownedClientIds]),
    ];
    const owner = await ensureOwnerCustomer(
      input.client,
      ownerUserId,
      publicClientIds,
    );
    await recordBillingCustomer({
      customerKey: owner.key,
      kind: "platform_user",
      platformUserId: ownerUserId,
      clientId: identity.developerAppId,
      openmeterCustomerId: owner.id,
    });
    return owner;
  }

  const customer = await ensureOpenMeterCustomer(
    input.client,
    identity.customerKey,
    input.displayName,
  );
  await recordBillingCustomer({
    customerKey: customer.key,
    kind: isEndUserCustomerKey(customer.key) ? "end_user" : "platform_user",
    endUserId: parseEndUserCustomerKey(customer.key) ?? undefined,
    clientId: identity.developerAppId,
    openmeterCustomerId: customer.id,
  });
  return customer;
}

/**
 * Persist / refresh the local OpenMeter customer registry row.
 * Best-effort — never fails the billing hot path when Neon is briefly unavailable.
 */
export async function recordBillingCustomer(input: {
  customerKey: string;
  kind: "platform_user" | "end_user";
  platformUserId?: string;
  endUserId?: string;
  clientId: string;
  openmeterCustomerId?: string | null;
}): Promise<void> {
  const customerKey = input.customerKey.trim();
  const openmeterCustomerId = input.openmeterCustomerId?.trim();
  if (!customerKey || !openmeterCustomerId) {
    return;
  }
  // plans/billing_customers.client_id is developer_apps.id — callers sometimes
  // pass the public app_… oidc id (especially audit spendable probes).
  const clientId = await resolveBillingCustomersClientId(input.clientId);
  if (!clientId) {
    return;
  }
  const now = new Date().toISOString();
  const kind = input.kind;
  const platformUserId = input.platformUserId?.trim() || null;
  const endUserId = input.endUserId?.trim() || null;
  try {
    await db
      .insert(billingCustomers)
      .values({
        id: uuidv4(),
        customerKey,
        kind,
        platformUserId,
        endUserId,
        clientId,
        openmeterCustomerId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [billingCustomers.customerKey, billingCustomers.clientId],
        set: {
          kind,
          platformUserId,
          endUserId,
          openmeterCustomerId,
          updatedAt: now,
        },
      });
  } catch (err) {
    console.warn(
      "customers: billing_customers upsert failed",
      sanitizeForLog(customerKey),
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function resolveBillingCustomersClientId(
  clientIdOrPublic: string,
): Promise<string | null> {
  const trimmed = clientIdOrPublic.trim();
  if (!trimmed) return null;
  const byId = await db
    .select({ id: developerApps.id })
    .from(developerApps)
    .where(eq(developerApps.id, trimmed))
    .limit(1);
  if (byId[0]?.id) return byId[0].id;
  const byPublic = await db
    .select({ id: developerApps.id })
    .from(developerApps)
    .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(eq(oidcClients.clientId, trimmed))
    .limit(1);
  return byPublic[0]?.id ?? null;
}

/**
 * Merge metadata onto an existing OpenMeter customer without changing subjects.
 * Used to stamp settlement charge-model keys for merchant Custom Invoicing.
 */
export async function ensureCustomerMetadata(
  client: OpenMeter,
  customerId: string,
  metadata: Record<string, string>,
): Promise<void> {
  const customer = (await client.customers.get(customerId)) as OpenMeterCustomerRecord;
  if (!customer?.id) {
    throw new Error(`OpenMeter customer not found: ${customerId}`);
  }
  const subjectKeys = customer.usageAttribution?.subjectKeys ?? [];
  if (!customer.name?.trim() && !customer.key?.trim() && subjectKeys.length === 0) {
    throw new Error(
      `OpenMeter customer ${customerId} has no name, key, or subject keys; refusing metadata replace`,
    );
  }
  await ensureCustomerUsageAttribution(
    client,
    customer,
    subjectKeys,
    metadata,
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

async function listTenantCustomersFromRegistry(
  clientId: string,
): Promise<Array<{ id: string; key: string }>> {
  const trimmed = clientId.trim();
  if (!trimmed) {
    return [];
  }
  // Resolve developer_apps.id from a public client id or pass-through app id.
  const byPublic = await db
    .select({ developerAppId: developerApps.id })
    .from(developerApps)
    .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(eq(oidcClients.clientId, trimmed))
    .limit(1);
  const developerAppId = byPublic[0]?.developerAppId?.trim() || trimmed;

  const rows = await db
    .select({
      id: billingCustomers.openmeterCustomerId,
      key: billingCustomers.customerKey,
      kind: billingCustomers.kind,
    })
    .from(billingCustomers)
    .where(eq(billingCustomers.clientId, developerAppId));
  // Tenant invoice / credit lists are end-user customers. Shared owner
  // wallets are resolved separately (resolveOwnerCustomerIdsForApp) — a
  // platform_user registry row whose client_id was last touched by another
  // app of the same owner must not leak into this app's end-user list.
  return rows.filter(
    (row) => row.id && row.key && row.kind === "end_user",
  );
}

async function listTenantCustomersFromOpenMeterPrefix(
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

/**
 * List OpenMeter customers attributed to an app.
 * Prefers the Neon `billing_customers` registry (works for `eu_…` keys);
 * falls back to the legacy OpenMeter key-prefix scan for unmigrated rows.
 */
export async function listTenantCustomers(
  client: OpenMeter,
  clientId: string,
): Promise<Array<{ id: string; key: string }>> {
  const fromRegistry = await listTenantCustomersFromRegistry(clientId).catch(
    () => [] as Array<{ id: string; key: string }>,
  );
  const fromPrefix = await listTenantCustomersFromOpenMeterPrefix(
    client,
    clientId,
  ).catch(() => [] as Array<{ id: string; key: string }>);

  const byKey = new Map<string, { id: string; key: string }>();
  for (const row of [...fromRegistry, ...fromPrefix]) {
    byKey.set(row.key, row);
  }
  return [...byKey.values()];
}

export async function listTenantCustomerIds(
  client: OpenMeter,
  clientId: string,
): Promise<string[]> {
  const rows = await listTenantCustomers(client, clientId);
  return rows.map((row) => row.id);
}
