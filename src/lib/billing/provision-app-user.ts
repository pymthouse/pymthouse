import { createAsyncTtlCache, resolveCacheTtlSeconds } from "@/lib/async-ttl-cache";
import { findOrCreateAppEndUser } from "@/lib/billing";
import { getHostedAdminClient, isHostedAdminClientAvailable } from "@/lib/openmeter/admin-client";
import {
  ensureOpenMeterCustomerForAppUser,
  type OpenMeterCustomerIdentity,
} from "@/lib/openmeter/customers";
import { ensureStarterSubscriptionForAppUser } from "@/lib/openmeter/starter-subscription";
import { resolveOrCreateAppUser } from "@/lib/usage/record-signed-ticket";

export type ProvisionAppUserBillingResult = {
  appUserId: string;
  endUserId: string;
  externalUserId: string;
  starterSubscriptionCreated: boolean;
  starterSubscriptionReady: boolean;
};

/** Konnect/OpenMeter customer + subject attribution only (no DB plan/subscription). */
export async function ensureAppUserKonnectCustomer(input: {
  clientId: string;
  externalUserId: string;
  displayName?: string;
}): Promise<OpenMeterCustomerIdentity> {
  if (!isHostedAdminClientAvailable()) {
    throw new Error(
      "OpenMeter is not configured (set OPENMETER_URL; OPENMETER_API_KEY for Konnect)",
    );
  }
  return ensureOpenMeterCustomerForAppUser({
    client: getHostedAdminClient(),
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });
}

/**
 * Fully-provisioned (app, user) pairs are remembered per process so hot-path
 * callers (composite token-exchange mints on the remote-signer webhook) skip
 * the OpenMeter provisioning fan-out entirely. Provisioning is an idempotent
 * ensure; the balance gate still reads live spendable data, so a stale entry
 * can only delay re-provisioning by the TTL, never over-authorize.
 */
let provisionedCache: ReturnType<
  typeof createAsyncTtlCache<ProvisionAppUserBillingResult>
> | null = null;

function getProvisionedCache() {
  provisionedCache ??= createAsyncTtlCache<ProvisionAppUserBillingResult>({
    ttlSeconds: resolveCacheTtlSeconds("APP_USER_PROVISION_CACHE_TTL_SECONDS", 300),
  });
  return provisionedCache;
}

export function resetProvisionedAppUserCacheForTests(): void {
  provisionedCache = null;
}

async function provisionAppUserBillingUncached(input: {
  clientId: string;
  externalUserId: string;
}): Promise<ProvisionAppUserBillingResult> {
  const externalUserId = input.externalUserId.trim();
  // Independent Neon upserts — run them concurrently.
  const [appUser, endUser] = await Promise.all([
    resolveOrCreateAppUser({
      clientId: input.clientId,
      externalUserId,
    }),
    findOrCreateAppEndUser(input.clientId, externalUserId),
  ]);

  // ensureStarterSubscriptionForAppUser already syncs the Starter plan and
  // ensures the OpenMeter customer + billing profile internally; no separate
  // trial-allowance ensure is needed here.
  const sub = await ensureStarterSubscriptionForAppUser({
    clientId: input.clientId,
    externalUserId,
  });

  return {
    appUserId: appUser.id,
    endUserId: endUser.id,
    externalUserId,
    starterSubscriptionCreated: sub.created,
    starterSubscriptionReady: isHostedAdminClientAvailable()
      ? Boolean(sub.openmeterSubscriptionId)
      : true,
  };
}

/**
 * Upsert app/end-user rows and ensure OpenMeter customer + Starter subscription.
 * Callers that need a live balance should use {@link getSpendableUsdMicros}.
 */
export async function provisionAppUserBilling(input: {
  clientId: string;
  externalUserId: string;
}): Promise<ProvisionAppUserBillingResult> {
  const clientId = input.clientId.trim();
  const externalUserId = input.externalUserId.trim();
  const cache = getProvisionedCache();
  const result = await cache.get(`${clientId}\u0000${externalUserId}`, () =>
    provisionAppUserBillingUncached({ clientId, externalUserId }),
  );
  // Only fully-ready provisioning results are worth remembering; partial
  // results (e.g. subscription not yet live) must retry on the next call.
  if (!result.starterSubscriptionReady) {
    cache.delete(`${clientId}\u0000${externalUserId}`);
  }
  return result;
}
