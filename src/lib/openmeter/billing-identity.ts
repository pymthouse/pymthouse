import { eq, inArray } from "drizzle-orm";

import { db } from "@/db/index";
import { developerApps, oidcClients } from "@/db/schema";
import {
  buildOpenMeterCustomerKey,
  buildOwnerCustomerKey,
  isOwnerCustomerKey,
  normalizePlatformUserId,
  parseOwnerCustomerKey,
} from "@/lib/openmeter/customer-key";

export type ResolvedBillingIdentity = {
  /**
   * Konnect customer key for credits/Starter (`owner:{users.id}` for owners;
   * compound `app_…:externalUserId` for end-users). Metering wire subject is
   * always compound — linked via usageAttribution.subjectKeys for owners.
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
    })
    .from(developerApps)
    .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(eq(oidcClients.clientId, id))
    .limit(1);

  if (byPublic[0]?.publicClientId) {
    return byPublic[0];
  }

  const byAppId = await db
    .select({
      developerAppId: developerApps.id,
      publicClientId: oidcClients.clientId,
      ownerId: developerApps.ownerId,
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
  };
}

/**
 * Resolve the OpenMeter billing customer for an (app, external user) pair.
 * App owners map to a single `owner:{users.id}` customer across all apps;
 * M2M end-users stay on `app_…:externalUserId`.
 */
export async function resolveOpenMeterBillingIdentity(input: {
  clientId: string;
  externalUserId: string;
}): Promise<ResolvedBillingIdentity> {
  const externalUserId = input.externalUserId.trim();
  if (!externalUserId) {
    throw new Error("externalUserId is required");
  }

  const app = await loadAppIdentity(input.clientId);
  if (!app) {
    // Fall back: treat input clientId as public id (tests / scripts).
    const customerKey = isOwnerCustomerKey(externalUserId)
      ? externalUserId
      : buildOpenMeterCustomerKey(input.clientId.trim(), externalUserId);
    return {
      customerKey,
      isOwner: isOwnerCustomerKey(customerKey),
      ownerUserId: parseOwnerCustomerKey(customerKey) ?? undefined,
      publicClientId: input.clientId.trim(),
      developerAppId: input.clientId.trim(),
    };
  }

  if (isOwnerCustomerKey(externalUserId)) {
    const ownerUserId = parseOwnerCustomerKey(externalUserId)!;
    return {
      customerKey: externalUserId,
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
