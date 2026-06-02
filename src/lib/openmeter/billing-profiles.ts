import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/db/index";
import { appBillingConfig } from "@/db/schema";
import type { OpenMeter } from "@openmeter/sdk";
import { getHostedAdminClient } from "./admin-client";
import { assignCustomerBillingProfileOverride } from "./customers";

export async function getAppBillingConfig(clientId: string) {
  const rows = await db
    .select()
    .from(appBillingConfig)
    .where(eq(appBillingConfig.clientId, clientId))
    .limit(1);
  return rows[0] ?? null;
}

export async function ensureTenantBillingProfile(input: {
  clientId: string;
  openmeterStripeAppId: string;
  name?: string;
}): Promise<string> {
  const client = getHostedAdminClient();
  const existing = await getAppBillingConfig(input.clientId);
  if (existing?.openmeterBillingProfileId) {
    return existing.openmeterBillingProfileId;
  }

  const profile = await client.billing.profiles.create({
    name: input.name || `pymthouse-${input.clientId}`,
    default: false,
    supplier: {
      name: input.name || `Tenant ${input.clientId}`,
    },
    workflow: {
      invoicing: { autoAdvance: true, draftPeriod: "P0D" },
      payment: { collectionMethod: "charge_automatically" },
    },
    apps: {
      tax: input.openmeterStripeAppId,
      invoicing: input.openmeterStripeAppId,
      payment: input.openmeterStripeAppId,
    },
  });

  if (!profile?.id) {
    throw new Error("Failed to create OpenMeter billing profile");
  }

  const now = new Date().toISOString();
  if (existing) {
    await db
      .update(appBillingConfig)
      .set({
        openmeterBillingProfileId: profile.id,
        updatedAt: now,
      })
      .where(eq(appBillingConfig.clientId, input.clientId));
  }

  return profile.id;
}

export async function applyTenantBillingProfileToCustomer(input: {
  client: OpenMeter;
  clientId: string;
  customerId: string;
}): Promise<void> {
  const config = await getAppBillingConfig(input.clientId);
  if (!config?.openmeterBillingProfileId) {
    return;
  }
  await assignCustomerBillingProfileOverride({
    client: input.client,
    customerId: input.customerId,
    billingProfileId: config.openmeterBillingProfileId,
  });
}

export async function upsertAppBillingConfig(
  clientId: string,
  values: Partial<typeof appBillingConfig.$inferInsert>,
): Promise<void> {
  const existing = await getAppBillingConfig(clientId);
  const now = new Date().toISOString();
  if (existing) {
    await db
      .update(appBillingConfig)
      .set({ ...values, updatedAt: now })
      .where(eq(appBillingConfig.clientId, clientId));
    return;
  }
  await db.insert(appBillingConfig).values({
    id: uuidv4(),
    clientId,
    stripeConnectStatus: "disconnected",
    defaultCurrency: "USD",
    createdAt: now,
    updatedAt: now,
    ...values,
  });
}
