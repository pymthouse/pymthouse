import { eq, inArray } from "drizzle-orm";

import { db } from "@/db/index";
import { developerApps, oidcClients } from "@/db/schema";
import { createAsyncTtlCache, resolveCacheTtlSeconds } from "@/lib/async-ttl-cache";
import {
  buildOpenMeterCustomerKey,
  buildOwnerCustomerKey,
  isOwnerWireSubject,
  normalizePlatformUserId,
  parseOwnerCustomerKey,
} from "@/lib/openmeter/customer-key";

export type ResolvedBillingIdentity = {
  /**
   * Konnect customer key for credits/Starter (bare `{users.id}` for owners;
   * compound `app_…:externalUserId` for end-users). Metering wire subject for
   * owners is `owner:{id}` inside auth_id; the collector strips the prefix.
   */
  customerKey: string;
  isOwner: boolean;
  /** Platform users.id when isOwner. */
  ownerUserId?: string;
  /** Public OIDC client_id (`app_…`) for event data and end-user keys. */
  publicClientId: string;
  /** developer_apps.id for plans / app_users rows. */
  developerAppId: string;
};

type AppIdentityRow = {
  developerAppId: string;
  publicClientId: string;
  ownerId: string;
  isPlatformDefault: boolean;
};

async function loadAppIdentity(clientIdOrAppId: string): Promise<AppIdentityRow | null> {
  const id = clientIdOrAppId.trim();
  if (!id) {
    return null;
  }

  const byPublic = await db
    .select({
      developerAppId: developerApps.id,
      publicClientId: oidcClients.clientId,
      ownerId: developerApps.ownerId,
      isPlatformDefault: developerApps.isPlatformDefault,
    })
    .from(developerApps)
    .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(eq(oidcClients.clientId, id))
    .limit(1);

  if (byPublic[0]?.publicClientId) {
    return {
      developerAppId: byPublic[0].developerAppId,
      publicClientId: byPublic[0].publicClientId,
      ownerId: byPublic[0].ownerId,
      isPlatformDefault: byPublic[0].isPlatformDefault === 1,
    };
  }

  const byAppId = await db
    .select({
      developerAppId: developerApps.id,
      publicClientId: oidcClients.clientId,
      ownerId: developerApps.ownerId,
      isPlatformDefault: developerApps.isPlatformDefault,
    })
    .from(developerApps)
    .leftJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(eq(developerApps.id, id))
    .limit(1);

  const row = byAppId[0];
  if (!row?.developerAppId) {
    return null;
  }
  return {
    developerAppId: row.developerAppId,
    publicClientId: row.publicClientId?.trim() || row.developerAppId,
    ownerId: row.ownerId,
    isPlatformDefault: row.isPlatformDefault === 1,
  };
}

/**
 * App→client→owner mappings change only on rare admin operations, but the
 * remote-signer hot path resolves them many times per request across mint,
 * provisioning, and balance reads. Cache per (clientId, externalUserId) so a
 * webhook invocation costs at most one Neon identity round-trip.
 */
let identityCache: ReturnType<
  typeof createAsyncTtlCache<ResolvedBillingIdentity>
> | null = null;

function getIdentityCache() {
  identityCache ??= createAsyncTtlCache<ResolvedBillingIdentity>({
    ttlSeconds: resolveCacheTtlSeconds("BILLING_IDENTITY_CACHE_TTL_SECONDS", 300),
  });
  return identityCache;
}

export function resetBillingIdentityCacheForTests(): void {
  identityCache = null;
}

/**
 * Resolve the OpenMeter billing customer for an (app, external user) pair.
 * App owners map to a single bare `{users.id}` customer across all apps;
 * platform-default (Livepeer Direct) members bill their own owner wallet;
 * M2M end-users on normal apps stay on `app_…:externalUserId`.
 */
export async function resolveOpenMeterBillingIdentity(input: {
  clientId: string;
  externalUserId: string;
}): Promise<ResolvedBillingIdentity> {
  const externalUserId = input.externalUserId.trim();
  if (!externalUserId) {
    throw new Error("externalUserId is required");
  }
  const clientId = input.clientId.trim();
  return getIdentityCache().get(`${clientId}\u0000${externalUserId}`, () =>
    resolveOpenMeterBillingIdentityUncached({ clientId, externalUserId }),
  );
}

async function resolveOpenMeterBillingIdentityUncached(input: {
  clientId: string;
  externalUserId: string;
}): Promise<ResolvedBillingIdentity> {
  const externalUserId = input.externalUserId;
  const app = await loadAppIdentity(input.clientId);
  if (!app) {
    // Fall back: treat input clientId as public id (tests / scripts).
    // Only wire `owner:{id}` marks owners here — bare UUIDs are common end-user ids.
    if (isOwnerWireSubject(externalUserId)) {
      const ownerUserId = parseOwnerCustomerKey(externalUserId)!;
      return {
        customerKey: buildOwnerCustomerKey(ownerUserId),
        isOwner: true,
        ownerUserId,
        publicClientId: input.clientId.trim(),
        developerAppId: input.clientId.trim(),
      };
    }
    return {
      customerKey: buildOpenMeterCustomerKey(input.clientId.trim(), externalUserId),
      isOwner: false,
      publicClientId: input.clientId.trim(),
      developerAppId: input.clientId.trim(),
    };
  }

  if (isOwnerWireSubject(externalUserId)) {
    const ownerUserId = parseOwnerCustomerKey(externalUserId)!;
    return {
      customerKey: buildOwnerCustomerKey(ownerUserId),
      isOwner: true,
      ownerUserId,
      publicClientId: app.publicClientId,
      developerAppId: app.developerAppId,
    };
  }

  const normalized = normalizePlatformUserId(externalUserId);
  if (app.ownerId && normalized === app.ownerId) {
    return {
      customerKey: buildOwnerCustomerKey(app.ownerId),
      isOwner: true,
      ownerUserId: app.ownerId,
      publicClientId: app.publicClientId,
      developerAppId: app.developerAppId,
    };
  }

  // Explorer / personal network keys on Livepeer Direct: each platform user
  // bills their own owner wallet (Owner Starter), not the admin app owner.
  if (app.isPlatformDefault) {
    return {
      customerKey: buildOwnerCustomerKey(normalized),
      isOwner: true,
      ownerUserId: normalized,
      publicClientId: app.publicClientId,
      developerAppId: app.developerAppId,
    };
  }

  return {
    customerKey: buildOpenMeterCustomerKey(app.publicClientId, externalUserId),
    isOwner: false,
    publicClientId: app.publicClientId,
    developerAppId: app.developerAppId,
  };
}

/** True when this external user id is the owner of the given app. */
export async function isAppOwnerExternalUser(input: {
  clientId: string;
  externalUserId: string;
}): Promise<boolean> {
  const resolved = await resolveOpenMeterBillingIdentity(input);
  return resolved.isOwner;
}

/**
 * Thrown when an app retail subscription mutation targets the shared owner
 * wallet (ADR: an owner is never subscribed to a plan on an app they own).
 */
export class AppUserOwnerWalletMutationError extends Error {
  readonly code = "owner_wallet_not_app_user" as const;

  constructor(
    message = "App retail subscription mutations cannot target the owner wallet; use Owner Paid billing APIs",
  ) {
    super(message);
    this.name = "AppUserOwnerWalletMutationError";
  }
}

/**
 * Sync reject for explicit `owner:{users.id}` wire subjects (no DB required).
 */
export function rejectOwnerWireRetailSubject(externalUserId: string): void {
  if (isOwnerWireSubject(externalUserId.trim())) {
    throw new AppUserOwnerWalletMutationError();
  }
}

/**
 * Reject app-user retail plan checkout/change/cancel/resume when the path
 * externalUserId resolves to the shared owner wallet. Without this guard,
 * M2M callers can cancel or replace the platform Owner Paid subscription, or
 * park the owner customer on the free billing profile during Checkout.
 */
export async function assertAppUserRetailBillingSubject(input: {
  clientId: string;
  externalUserId: string;
}): Promise<void> {
  rejectOwnerWireRetailSubject(input.externalUserId);
  if (await isAppOwnerExternalUser(input)) {
    throw new AppUserOwnerWalletMutationError();
  }
}

/**
 * List distinct platform owner ids for the given developer apps (for migration).
 */
export async function listOwnerIdsForDeveloperApps(
  developerAppIds: string[],
): Promise<string[]> {
  const unique = [...new Set(developerAppIds.map((id) => id.trim()).filter(Boolean))];
  if (unique.length === 0) {
    return [];
  }
  const rows = await db
    .select({ ownerId: developerApps.ownerId })
    .from(developerApps)
    .where(inArray(developerApps.id, unique));
  return [...new Set(rows.map((r) => r.ownerId).filter(Boolean))];
}
