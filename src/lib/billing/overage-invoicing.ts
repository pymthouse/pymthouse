/**
 * Mode-aware overage unlock for mint / live signer balance gates.
 *
 * - Owner identity → Owner Paid + platform PM (existing predicate).
 * - End-user + owner_rollup → same owner predicate (cost rail).
 * - End-user + merchant → Connect-ready end-user PM + overage-capable plan.
 *
 * Chargeability `null` (lookup failure) never unlocks — fail closed, matching
 * owner mint semantics.
 */
import { and, desc, eq, inArray } from "drizzle-orm";

import { db } from "@/db/index";
import { plans, subscriptions } from "@/db/schema";
import { planRequiresPaymentMethod } from "@/lib/openmeter/subscriptions-billing";
import {
  appUserHasChargeablePaymentMethod,
} from "@/lib/openmeter/app-user-payment-method";
import { getAppBillingConfig } from "@/lib/openmeter/billing-profiles";
import type { ResolvedBillingIdentity } from "@/lib/openmeter/billing-identity";
import { resolveOpenMeterBillingIdentity } from "@/lib/openmeter/billing-identity";
import { isMerchantConnectPaymentsReady } from "@/lib/stripe/merchant-connect";
import { getProviderApp } from "@/lib/provider-apps";

/** Pure mode matrix for overage unlock (unit-testable without I/O). */
export function decideAllowsOverageInvoicing(input: {
  isOwner: boolean;
  billingMode: string | null | undefined;
  ownerAllowsOverage: boolean;
  merchantConnectReady: boolean;
  /** `null` = unknown — fail closed. */
  merchantChargeable: boolean | null;
  merchantHasOverageCapablePlan: boolean;
}): boolean {
  if (input.isOwner) {
    return input.ownerAllowsOverage;
  }
  if (input.billingMode === "merchant") {
    return (
      input.merchantConnectReady &&
      input.merchantChargeable === true &&
      input.merchantHasOverageCapablePlan
    );
  }
  // owner_rollup (and unset): end-user usage is the owner's cost rail.
  return input.ownerAllowsOverage;
}

export async function appUserHasOverageCapablePlan(input: {
  /** developer_apps.id */
  appId: string;
  externalUserId: string;
}): Promise<boolean> {
  const appId = input.appId.trim();
  const externalUserId = input.externalUserId.trim();
  if (!appId || !externalUserId) {
    return false;
  }

  const rows = await db
    .select({
      type: plans.type,
      priceAmount: plans.priceAmount,
      isStarterDefault: plans.isStarterDefault,
      isNetworkDefault: plans.isNetworkDefault,
    })
    .from(subscriptions)
    .innerJoin(plans, eq(subscriptions.planId, plans.id))
    .where(
      and(
        eq(subscriptions.clientId, appId),
        eq(subscriptions.externalUserId, externalUserId),
        inArray(subscriptions.status, ["active", "trialing"]),
      ),
    )
    .orderBy(desc(subscriptions.createdAt))
    .limit(5);

  return rows.some((row) =>
    planRequiresPaymentMethod({
      type: row.type,
      priceAmount: row.priceAmount ?? "0",
      isStarterDefault: row.isStarterDefault,
      isNetworkDefault: row.isNetworkDefault,
    }),
  );
}

/**
 * True when a merchant end-user may continue past spendable=0.
 */
export async function appUserAllowsOverageInvoicing(input: {
  /** developer_apps.id (app_billing_config.client_id) */
  appId: string;
  externalUserId: string;
}): Promise<boolean> {
  const appId = input.appId.trim();
  const externalUserId = input.externalUserId.trim();
  if (!appId || !externalUserId) {
    return false;
  }

  const billingConfig = await getAppBillingConfig(appId);
  if (billingConfig?.billingMode !== "merchant") {
    return false;
  }

  const chargeable = await appUserHasChargeablePaymentMethod({
    clientId: appId,
    externalUserId,
  });
  const hasPlan = await appUserHasOverageCapablePlan({ appId, externalUserId });

  return decideAllowsOverageInvoicing({
    isOwner: false,
    billingMode: "merchant",
    ownerAllowsOverage: false,
    merchantConnectReady: isMerchantConnectPaymentsReady(billingConfig),
    merchantChargeable: chargeable,
    merchantHasOverageCapablePlan: hasPlan,
  });
}

/**
 * Resolve whether mint/signer may authorize this identity at spendable=0.
 */
export async function resolveAllowsOverageInvoicing(input: {
  clientId: string;
  externalUserId: string;
  identity?: ResolvedBillingIdentity;
}): Promise<boolean> {
  const externalUserId = input.externalUserId.trim();
  if (!externalUserId) {
    return false;
  }

  const identity =
    input.identity ??
    (await resolveOpenMeterBillingIdentity({
      clientId: input.clientId,
      externalUserId,
    }));

  if (identity.isOwner && identity.ownerUserId) {
    const { ownerWalletAllowsOverageInvoicing } = await import(
      "@/lib/openmeter/owner-paid-plan"
    );
    const ownerAllows = await ownerWalletAllowsOverageInvoicing(
      identity.ownerUserId,
    );
    return decideAllowsOverageInvoicing({
      isOwner: true,
      billingMode: null,
      ownerAllowsOverage: ownerAllows,
      merchantConnectReady: false,
      merchantChargeable: false,
      merchantHasOverageCapablePlan: false,
    });
  }

  const app =
    (await getProviderApp(identity.developerAppId)) ??
    (await getProviderApp(identity.publicClientId)) ??
    (await getProviderApp(input.clientId.trim()));
  const appId = app?.id?.trim();
  if (!appId) {
    return false;
  }

  const billingConfig = await getAppBillingConfig(appId);
  if (billingConfig?.billingMode === "merchant") {
    return appUserAllowsOverageInvoicing({
      appId,
      externalUserId,
    });
  }

  // owner_rollup: end-user usage is the owner's cost rail.
  const ownerId = app.ownerId?.trim();
  if (!ownerId) {
    return false;
  }
  const { ownerWalletAllowsOverageInvoicing } = await import(
    "@/lib/openmeter/owner-paid-plan"
  );
  const ownerAllows = await ownerWalletAllowsOverageInvoicing(ownerId);
  return decideAllowsOverageInvoicing({
    isOwner: false,
    billingMode: billingConfig?.billingMode ?? "owner_rollup",
    ownerAllowsOverage: ownerAllows,
    merchantConnectReady: false,
    merchantChargeable: false,
    merchantHasOverageCapablePlan: false,
  });
}
