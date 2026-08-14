import { eq, inArray } from "drizzle-orm";

import { db } from "@/db/index";
import { appBillingConfig, developerApps, oidcClients } from "@/db/schema";
import { createAsyncTtlCache, resolveCacheTtlSeconds } from "@/lib/async-ttl-cache";
import { findOrCreateAppEndUser } from "@/lib/billing";
import {
  buildEndUserCustomerKey,
  buildOpenMeterCustomerKey,
  buildOwnerCustomerKey,
  buildOwnerWireSubject,
  isEndUserCustomerKey,
  isOwnerWireSubject,
  normalizePlatformUserId,
  parseOwnerCustomerKey,
} from "@/lib/openmeter/customer-key";

/** JWT claim: owner_rollup end-user tokens name the app owner's wallet (legacy). */
export const COST_OWNER_USER_ID_CLAIM = "cost_owner_user_id";

/** JWT claim: OpenMeter payer customer key (owner bare id or `eu_…`). */
export const BILLING_SUBJECT_KEY_CLAIM = "billing_subject_key";

/** Separator between payer and actor in the wire `usage_subject`. */
export const PAYER_ACTOR_WIRE_SEPARATOR = "#";

export type BillingPayerKind = "platform_user" | "end_user";

export type ResolvedBillingIdentity = {
  /**
   * Konnect customer key for credits, Starter, and CloudEvent subject.
   * Alias of {@link payerCustomerKey} — kept for call-site churn.
   */
  customerKey: string;
  /** OpenMeter customer that is charged (payer). Never encodes an app id. */
  payerCustomerKey: string;
  payerKind: BillingPayerKind;
  /**
   * Platform users.id of the cost-rail wallet when the payer is a platform user.
   * Set for owners, Explorers, and owner_rollup end-users.
   */
  payerPlatformUserId?: string;
  isOwner: boolean;
  /**
   * True when network usage, spendable balance, and prepaid credits live on
   * the owner platform wallet — including owner_rollup end-users who are not
   * themselves the owner.
   */
  sharesOwnerCostRail: boolean;
  /**
   * Stable actor customer key (`eu_{end_users.id}`) when the actor is an
   * end-user; bare platform user id when the actor is the owner / Explorer.
   */
  actorEndUserId: string;
  /** App-scoped external user id used for meter groupBy / analytics. */
  actorExternalUserId: string;
  /** Public OIDC client_id (`app_…`) for event data and end-user keys. */
  publicClientId: string;
  /** developer_apps.id for plans / app_users rows. */
  developerAppId: string;
  /**
   * Legacy compound customer key `app_…:externalUserId` for dual-read during
   * the end-user customer migration. Absent for pure platform-user payers.
   */
  legacyCompoundCustomerKey?: string;
};

type AppIdentityRow = {
  developerAppId: string;
  publicClientId: string;
  ownerId: string;
  isPlatformDefault: boolean;
  billingMode: "owner_rollup" | "merchant";
};

function platformUserIdentity(input: {
  platformUserId: string;
  isOwner: boolean;
  publicClientId: string;
  developerAppId: string;
  actorExternalUserId: string;
}): ResolvedBillingIdentity {
  const payerCustomerKey = buildOwnerCustomerKey(input.platformUserId);
  return {
    customerKey: payerCustomerKey,
    payerCustomerKey,
    payerKind: "platform_user",
    payerPlatformUserId: input.platformUserId,
    isOwner: input.isOwner,
    sharesOwnerCostRail: true,
    actorEndUserId: input.platformUserId,
    actorExternalUserId: input.actorExternalUserId,
    publicClientId: input.publicClientId,
    developerAppId: input.developerAppId,
  };
}

function endUserIdentity(input: {
  payerCustomerKey: string;
  payerKind: BillingPayerKind;
  payerPlatformUserId?: string;
  sharesOwnerCostRail: boolean;
  actorEndUserId: string;
  actorExternalUserId: string;
  publicClientId: string;
  developerAppId: string;
  legacyCompoundCustomerKey: string;
}): ResolvedBillingIdentity {
  return {
    customerKey: input.payerCustomerKey,
    payerCustomerKey: input.payerCustomerKey,
    payerKind: input.payerKind,
    payerPlatformUserId: input.payerPlatformUserId,
    isOwner: false,
    sharesOwnerCostRail: input.sharesOwnerCostRail,
    actorEndUserId: input.actorEndUserId,
    actorExternalUserId: input.actorExternalUserId,
    publicClientId: input.publicClientId,
    developerAppId: input.developerAppId,
    legacyCompoundCustomerKey: input.legacyCompoundCustomerKey,
  };
}

async function resolveEndUserActorIds(input: {
  developerAppId: string;
  publicClientId: string;
  externalUserId: string;
}): Promise<{
  actorEndUserId: string;
  endUserCustomerKey: string;
  legacyCompoundCustomerKey: string;
}> {
  const { id: endUserRowId } = await findOrCreateAppEndUser(
    input.developerAppId,
    input.externalUserId,
  );
  const endUserCustomerKey = buildEndUserCustomerKey(endUserRowId);
  return {
    actorEndUserId: endUserCustomerKey,
    endUserCustomerKey,
    legacyCompoundCustomerKey: buildOpenMeterCustomerKey(
      input.publicClientId,
      input.externalUserId,
    ),
  };
}

/** Owner wallet id when this identity's cost rail is the shared owner customer. */
export function ownerCostRailUserId(
  identity: ResolvedBillingIdentity,
): string | undefined {
  if (!identity.sharesOwnerCostRail) {
    return undefined;
  }
  const ownerUserId = identity.payerPlatformUserId?.trim();
  return ownerUserId || undefined;
}

/**
 * Webhook / mint cache key for spendable checks: `owner:{id}` on the cost rail
 * so owner_rollup end-users share the owner's balance gate; otherwise the
 * payer customer key (or actor external id as a last resort).
 */
export function signerBalanceGateSubject(
  identity: ResolvedBillingIdentity,
  externalUserId: string,
): string {
  const ownerUserId = ownerCostRailUserId(identity);
  if (ownerUserId) {
    return buildOwnerWireSubject(ownerUserId);
  }
  if (identity.payerCustomerKey.trim()) {
    return identity.payerCustomerKey.trim();
  }
  return externalUserId.trim();
}

/**
 * @deprecated Prefer {@link billingSubjectClaim}. Kept so existing call sites
 * and JWTs minted before the cutover continue to work.
 */
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
 * JWT claims that tell the webhook which OpenMeter customer to bill.
 * Emits `billing_subject_key` for every non-owner payer; also keeps
 * `cost_owner_user_id` for owner_rollup so pre-cutover collectors still work.
 */
export function billingSubjectClaim(
  identity: ResolvedBillingIdentity,
): Record<string, string> {
  if (identity.isOwner && identity.payerKind === "platform_user") {
    return {};
  }
  const claims: Record<string, string> = {
    [BILLING_SUBJECT_KEY_CLAIM]: identity.payerCustomerKey,
  };
  const ownerUserId = ownerCostRailUserId(identity);
  if (ownerUserId && !identity.isOwner) {
    claims[COST_OWNER_USER_ID_CLAIM] = ownerUserId;
  }
  return claims;
}

/**
 * Build the wire `usage_subject` that go-livepeer embeds in `auth_id`.
 * Format: `{payerWire}#{actorExternalUserId}` when the actor differs from the
 * payer wire form; bare payer wire otherwise (owner self-usage).
 */
export function buildPayerActorWireSubject(input: {
  payerCustomerKey: string;
  payerKind: BillingPayerKind;
  actorExternalUserId: string;
}): string {
  const actor = input.actorExternalUserId.trim();
  const payerWire =
    input.payerKind === "platform_user"
      ? buildOwnerWireSubject(input.payerCustomerKey)
      : input.payerCustomerKey.trim();
  if (!actor || actor === payerWire || actor === input.payerCustomerKey.trim()) {
    return payerWire;
  }
  return `${payerWire}${PAYER_ACTOR_WIRE_SEPARATOR}${actor}`;
}

export function parsePayerActorWireSubject(usageSubject: string): {
  payerWire: string;
  actorExternalUserId: string | null;
} {
  const trimmed = usageSubject.trim();
  const sep = trimmed.indexOf(PAYER_ACTOR_WIRE_SEPARATOR);
  if (sep <= 0 || sep >= trimmed.length - 1) {
    return { payerWire: trimmed, actorExternalUserId: null };
  }
  return {
    payerWire: trimmed.slice(0, sep),
    actorExternalUserId: trimmed.slice(sep + 1),
  };
}

/** Mint/webhook spendable cache key: payer side of `payer#actor`. */
export function signerSpendableCacheSubject(usageSubject: string): string {
  return parsePayerActorWireSubject(usageSubject).payerWire;
}

/**
 * Neon/OpenMeter lookup id from a webhook `usage_subject`.
 * Actor is the app external id mint used; fall back to the bare payer wire.
 */
export function signerSpendableLookupSubject(usageSubject: string): string {
  const parsed = parsePayerActorWireSubject(usageSubject);
  return parsed.actorExternalUserId ?? parsed.payerWire;
}

/**
 * Map JWT claims onto the webhook usage_subject the collector bills.
 * Prefer `billing_subject_key`; fall back to `cost_owner_user_id` so tokens
 * minted before the cutover still land on the owner wallet.
 */
export function wireUsageSubjectFromJwt(input: {
  userType: string;
  usageSubject: string;
  billingSubjectKey?: string | null;
  costOwnerUserId?: string | null;
  actorExternalUserId?: string | null;
}): {
  usageSubject: string;
  usageSubjectType: "app_owner" | "external_user_id";
} {
  const billingSubjectKey = input.billingSubjectKey?.trim() || "";
  const costOwnerUserId = input.costOwnerUserId?.trim() || "";
  const actor =
    input.actorExternalUserId?.trim() || input.usageSubject.trim() || "";

  if (billingSubjectKey) {
    const payerKind: BillingPayerKind = isEndUserCustomerKey(billingSubjectKey)
      ? "end_user"
      : "platform_user";
    const wire = buildPayerActorWireSubject({
      payerCustomerKey: billingSubjectKey,
      payerKind,
      actorExternalUserId: actor,
    });
    return {
      usageSubject: wire,
      usageSubjectType:
        payerKind === "platform_user" ? "app_owner" : "external_user_id",
    };
  }

  if (costOwnerUserId) {
    return {
      usageSubject: buildPayerActorWireSubject({
        payerCustomerKey: costOwnerUserId,
        payerKind: "platform_user",
        actorExternalUserId: actor,
      }),
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
 * merchant end-users bill their stable `eu_{end_users.id}` customer.
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
      return platformUserIdentity({
        platformUserId: ownerUserId,
        isOwner: true,
        publicClientId: input.clientId.trim(),
        developerAppId: input.clientId.trim(),
        actorExternalUserId: ownerUserId,
      });
    }
    // Without a real app row we cannot mint an end_users id — keep the legacy
    // compound key as both payer and actor so scripts/tests still resolve.
    const legacyKey = buildOpenMeterCustomerKey(
      input.clientId.trim(),
      externalUserId,
    );
    return endUserIdentity({
      payerCustomerKey: legacyKey,
      payerKind: "end_user",
      sharesOwnerCostRail: false,
      actorEndUserId: externalUserId,
      actorExternalUserId: externalUserId,
      publicClientId: input.clientId.trim(),
      developerAppId: input.clientId.trim(),
      legacyCompoundCustomerKey: legacyKey,
    });
  }

  if (isOwnerWireSubject(externalUserId)) {
    const ownerUserId = parseOwnerCustomerKey(externalUserId)!;
    return platformUserIdentity({
      platformUserId: ownerUserId,
      isOwner: true,
      publicClientId: app.publicClientId,
      developerAppId: app.developerAppId,
      actorExternalUserId: ownerUserId,
    });
  }

  const normalized = normalizePlatformUserId(externalUserId);
  if (app.ownerId && normalized === app.ownerId) {
    return platformUserIdentity({
      platformUserId: app.ownerId,
      isOwner: true,
      publicClientId: app.publicClientId,
      developerAppId: app.developerAppId,
      actorExternalUserId: app.ownerId,
    });
  }

  // Explorer / personal network keys on Livepeer Direct: each platform user
  // bills their own owner wallet (Owner Starter), not the admin app owner.
  if (app.isPlatformDefault) {
    return platformUserIdentity({
      platformUserId: normalized,
      isOwner: true,
      publicClientId: app.publicClientId,
      developerAppId: app.developerAppId,
      actorExternalUserId: normalized,
    });
  }

  const actorIds = await resolveEndUserActorIds({
    developerAppId: app.developerAppId,
    publicClientId: app.publicClientId,
    externalUserId,
  });

  if (app.billingMode !== "merchant" && app.ownerId) {
    return endUserIdentity({
      payerCustomerKey: buildOwnerCustomerKey(app.ownerId),
      payerKind: "platform_user",
      payerPlatformUserId: app.ownerId,
      sharesOwnerCostRail: true,
      actorEndUserId: actorIds.actorEndUserId,
      actorExternalUserId: externalUserId,
      publicClientId: app.publicClientId,
      developerAppId: app.developerAppId,
      legacyCompoundCustomerKey: actorIds.legacyCompoundCustomerKey,
    });
  }

  return endUserIdentity({
    payerCustomerKey: actorIds.endUserCustomerKey,
    payerKind: "end_user",
    sharesOwnerCostRail: false,
    actorEndUserId: actorIds.actorEndUserId,
    actorExternalUserId: externalUserId,
    publicClientId: app.publicClientId,
    developerAppId: app.developerAppId,
    legacyCompoundCustomerKey: actorIds.legacyCompoundCustomerKey,
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
  if (identity.payerKind === "platform_user" || identity.sharesOwnerCostRail) {
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
