import { eq, inArray } from "drizzle-orm";

import { db } from "@/db/index";
import { appBillingConfig, developerApps, oidcClients } from "@/db/schema";
import { createAsyncTtlCache, resolveCacheTtlSeconds } from "@/lib/async-ttl-cache";
import {
  buildOpenMeterCustomerKey,
  buildOwnerCustomerKey,
  buildOwnerWireSubject,
  isOwnerWireSubject,
  normalizePlatformUserId,
  parseOwnerCustomerKey,
} from "@/lib/openmeter/customer-key";

/** JWT claim: owner_rollup end-user tokens name the app owner's wallet. */
export const COST_OWNER_USER_ID_CLAIM = "cost_owner_user_id";

export type ResolvedBillingIdentity = {
  /**
   * Konnect customer key for credits, Starter, and CloudEvent subject.
   * Owner cost rail (the owner, Explorer, or an owner_rollup end-user) is
   * bare `{users.id}`. Merchant end-users stay on `app_…:externalUserId`.
   */
  customerKey: string;
  isOwner: boolean;
  /**
   * Platform users.id of the cost-rail wallet when {@link sharesOwnerCostRail}.
   * Set for owners, Explorers, and owner_rollup end-users.
   */
  ownerUserId?: string;
  /**
   * True when network usage, spendable balance, and prepaid credits live on
   * the owner platform wallet — including owner_rollup end-users who are not
   * themselves the owner.
   */
  sharesOwnerCostRail: boolean;
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
  billingMode: "owner_rollup" | "merchant";
};

function ownerCostRailIdentity(input: {
  ownerUserId: string;
  isOwner: boolean;
  publicClientId: string;
  developerAppId: string;
}): ResolvedBillingIdentity {
  return {
    customerKey: buildOwnerCustomerKey(input.ownerUserId),
    isOwner: input.isOwner,
    ownerUserId: input.ownerUserId,
    sharesOwnerCostRail: true,
    publicClientId: input.publicClientId,
    developerAppId: input.developerAppId,
  };
}

function merchantEndUserIdentity(input: {
  publicClientId: string;
  developerAppId: string;
  externalUserId: string;
}): ResolvedBillingIdentity {
  return {
    customerKey: buildOpenMeterCustomerKey(
      input.publicClientId,
      input.externalUserId,
    ),
    isOwner: false,
    sharesOwnerCostRail: false,
    publicClientId: input.publicClientId,
    developerAppId: input.developerAppId,
  };
}

/** Owner wallet id when this identity's cost rail is the shared owner customer. */
export function ownerCostRailUserId(
  identity: ResolvedBillingIdentity,
): string | undefined {
  if (!identity.sharesOwnerCostRail) {
    return undefined;
  }
  const ownerUserId = identity.ownerUserId?.trim();
  return ownerUserId || undefined;
}

/**
 * Webhook / mint cache key for spendable checks: `owner:{id}` on the cost rail
 * so owner_rollup end-users share the owner's balance gate.
 */
export function signerBalanceGateSubject(
  identity: ResolvedBillingIdentity,
  externalUserId: string,
): string {
  const ownerUserId = ownerCostRailUserId(identity);
  if (ownerUserId) {
    return buildOwnerWireSubject(ownerUserId);
  }
  return externalUserId.trim();
}

/** JWT claims that tell the webhook to meter owner_rollup traffic to the owner. */
export function costOwnerUserIdClaim(
  identity: ResolvedBillingIdentity,
): Record<string, string> {
  const ownerUserId = ownerCostRailUserId(identity);
  if (!ownerUserId || identity.isOwner) {
    return {};
  }
  return { [COST_OWNER_USER_ID_CLAIM]: ownerUserId };
}

/**
 * Map JWT user_type / cost_owner_user_id onto the webhook usage_subject the
 * collector bills. `cost_owner_user_id` wins so owner_rollup end-users land
 * on the app owner's wallet, not `owner:{endUserId}`.
 */
export function ownerWireUsageSubjectFromJwt(input: {
  userType: string;
  usageSubject: string;
  costOwnerUserId?: string | null;
}): {
  usageSubject: string;
  usageSubjectType: "app_owner" | "external_user_id";
} {
  const costOwnerUserId = input.costOwnerUserId?.trim() || "";
  if (costOwnerUserId) {
    return {
      usageSubject: buildOwnerWireSubject(costOwnerUserId),
      usageSubjectType: "app_owner",
    };
  }
  if (input.userType.trim() !== "app_owner") {
    return {
      usageSubject: input.usageSubject,
      usageSubjectType: "external_user_id",
    };
  }
  const bareId = input.usageSubject.trim();
  if (!bareId || bareId.startsWith("owner:")) {
    return {
      usageSubject: bareId,
      usageSubjectType: "app_owner",
    };
  }
  return {
    usageSubject: buildOwnerWireSubject(bareId),
    usageSubjectType: "app_owner",
  };
}

function billingModeFromRow(
  billingMode: string | null | undefined,
): "owner_rollup" | "merchant" {
  return billingMode === "merchant" ? "merchant" : "owner_rollup";
}

async function loadAppIdentity(clientIdOrAppId: string): Promise<AppIdentityRow | null> {
  const id = clientIdOrAppId.trim();
  if (!id) {
    return null;
  }

  const appSelect = {
    developerAppId: developerApps.id,
    publicClientId: oidcClients.clientId,
    ownerId: developerApps.ownerId,
    isPlatformDefault: developerApps.isPlatformDefault,
    billingMode: appBillingConfig.billingMode,
  };

  const byPublic = await db
    .select(appSelect)
    .from(developerApps)
    .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .leftJoin(appBillingConfig, eq(appBillingConfig.clientId, developerApps.id))
    .where(eq(oidcClients.clientId, id))
    .limit(1);

  if (byPublic[0]?.publicClientId) {
    return {
      developerAppId: byPublic[0].developerAppId,
      publicClientId: byPublic[0].publicClientId,
      ownerId: byPublic[0].ownerId,
      isPlatformDefault: byPublic[0].isPlatformDefault === 1,
      billingMode: billingModeFromRow(byPublic[0].billingMode),
    };
  }

  const byAppId = await db
    .select(appSelect)
    .from(developerApps)
    .leftJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .leftJoin(appBillingConfig, eq(appBillingConfig.clientId, developerApps.id))
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
    billingMode: billingModeFromRow(row.billingMode),
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
 * App owners and owner_rollup end-users share the owner's `{users.id}` wallet;
 * platform-default (Livepeer Direct) members bill their own owner wallet;
 * merchant end-users stay on `app_…:externalUserId`.
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
      return ownerCostRailIdentity({
        ownerUserId,
        isOwner: true,
        publicClientId: input.clientId.trim(),
        developerAppId: input.clientId.trim(),
      });
    }
    return merchantEndUserIdentity({
      publicClientId: input.clientId.trim(),
      developerAppId: input.clientId.trim(),
      externalUserId,
    });
  }

  if (isOwnerWireSubject(externalUserId)) {
    const ownerUserId = parseOwnerCustomerKey(externalUserId)!;
    return ownerCostRailIdentity({
      ownerUserId,
      isOwner: true,
      publicClientId: app.publicClientId,
      developerAppId: app.developerAppId,
    });
  }

  const normalized = normalizePlatformUserId(externalUserId);
  if (app.ownerId && normalized === app.ownerId) {
    return ownerCostRailIdentity({
      ownerUserId: app.ownerId,
      isOwner: true,
      publicClientId: app.publicClientId,
      developerAppId: app.developerAppId,
    });
  }

  // Explorer / personal network keys on Livepeer Direct: each platform user
  // bills their own owner wallet (Owner Starter), not the admin app owner.
  if (app.isPlatformDefault) {
    return ownerCostRailIdentity({
      ownerUserId: normalized,
      isOwner: true,
      publicClientId: app.publicClientId,
      developerAppId: app.developerAppId,
    });
  }

  if (app.billingMode !== "merchant" && app.ownerId) {
    return ownerCostRailIdentity({
      ownerUserId: app.ownerId,
      isOwner: false,
      publicClientId: app.publicClientId,
      developerAppId: app.developerAppId,
    });
  }

  return merchantEndUserIdentity({
    publicClientId: app.publicClientId,
    developerAppId: app.developerAppId,
    externalUserId,
  });
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
  const identity = await resolveOpenMeterBillingIdentity(input);
  if (identity.sharesOwnerCostRail) {
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
