import { and, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/db/index";
import { billingAddons } from "@/db/schema";
import { getBillingClientForApp } from "./admin-client";
import { DEFAULT_TRIAL_FEATURE_KEY, getHostedOpenMeterUrl } from "./constants";
import { ensureOpenMeterCustomerForAppUser } from "./customers";
import { createKonnectCreditGrant } from "./konnect-credits";
import { shouldUseKonnectRoutes } from "./route-mode";
import { grantTrialCredits } from "./entitlements";
import { buildOpenMeterCustomerKey } from "./customer-key";
import { applyTenantBillingProfileToCustomer, getAppBillingConfig } from "./billing-profiles";

export async function listBillingAddons(clientId: string) {
  return db.select().from(billingAddons).where(eq(billingAddons.clientId, clientId));
}

export async function createBillingAddon(input: {
  clientId: string;
  name: string;
  description?: string | null;
  creditUsdMicros: string;
  priceAmount: string;
  priceCurrency?: string;
}) {
  if (!/^\d+$/.test(input.creditUsdMicros) || BigInt(input.creditUsdMicros) <= 0n) {
    throw new Error("creditUsdMicros must be a positive integer string");
  }
  const now = new Date().toISOString();
  const row = {
    id: uuidv4(),
    clientId: input.clientId,
    name: input.name.trim(),
    description: input.description?.trim() || null,
    creditUsdMicros: input.creditUsdMicros,
    priceAmount: input.priceAmount || "0",
    priceCurrency: (input.priceCurrency || "USD").toUpperCase(),
    status: "active",
    openmeterAddonId: null as string | null,
    lastSyncedAt: null as string | null,
    syncError: null as string | null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(billingAddons).values(row);
  return row;
}

export async function deleteBillingAddon(input: {
  clientId: string;
  addonId: string;
}): Promise<boolean> {
  const rows = await db
    .select()
    .from(billingAddons)
    .where(and(eq(billingAddons.id, input.addonId), eq(billingAddons.clientId, input.clientId)))
    .limit(1);
  if (!rows[0]) {
    return false;
  }
  await db.delete(billingAddons).where(eq(billingAddons.id, rows[0].id));
  return true;
}

/**
 * Purchase an add-on by granting prepaid credits and (when Stripe is connected)
 * creating a one-time checkout for the listed price.
 */
export async function purchaseBillingAddon(input: {
  clientId: string;
  externalUserId: string;
  addonId: string;
  successUrl?: string;
  cancelUrl?: string;
}): Promise<{ grantedUsdMicros: string; checkoutUrl?: string }> {
  const addonRows = await db
    .select()
    .from(billingAddons)
    .where(
      and(
        eq(billingAddons.id, input.addonId),
        eq(billingAddons.clientId, input.clientId),
        eq(billingAddons.status, "active"),
      ),
    )
    .limit(1);
  const addon = addonRows[0];
  if (!addon) {
    throw new Error("Add-on not found");
  }

  const client = await getBillingClientForApp(input.clientId);
  const customer = await ensureOpenMeterCustomerForAppUser({
    client,
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });

  const amountUsdMicros = BigInt(addon.creditUsdMicros);
  const omApiKey = process.env.OPENMETER_API_KEY?.trim();
  const useKonnect = shouldUseKonnectRoutes(getHostedOpenMeterUrl(), omApiKey);
  if (useKonnect) {
    await createKonnectCreditGrant({
      customerId: customer.id,
      amountUsdMicros,
      name: `Add-on: ${addon.name}`,
      description: addon.description ?? undefined,
      featureKey: DEFAULT_TRIAL_FEATURE_KEY,
      idempotencyKey: `addon:${addon.id}:${customer.id}:${Date.now()}`,
      apiKey: omApiKey,
    });
  } else {
    await grantTrialCredits({
      client,
      customerKey: buildOpenMeterCustomerKey(input.clientId, input.externalUserId),
      featureKey: DEFAULT_TRIAL_FEATURE_KEY,
      amountUsdMicros,
    });
  }

  const billingConfig = await getAppBillingConfig(input.clientId);
  let checkoutUrl: string | undefined;
  if (
    billingConfig?.stripeConnectStatus === "connected" &&
    Number(addon.priceAmount) > 0
  ) {
    await applyTenantBillingProfileToCustomer({
      client,
      clientId: input.clientId,
      customerId: customer.id,
    });
    const checkout = await client.apps.stripe.createCheckoutSession({
      customer: { id: customer.id },
      options: {
        successURL: input.successUrl || billingConfig.checkoutSuccessUrl || undefined,
        cancelURL: input.cancelUrl || billingConfig.checkoutCancelUrl || undefined,
      },
    });
    checkoutUrl = checkout?.url ?? undefined;
  }

  return {
    grantedUsdMicros: addon.creditUsdMicros,
    checkoutUrl,
  };
}
