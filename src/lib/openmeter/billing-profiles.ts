import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/db/index";
import { appBillingConfig } from "@/db/schema";
import type { OpenMeter } from "@openmeter/sdk";
import { getHostedAdminClient } from "./admin-client";
import { assignCustomerBillingProfileOverride } from "./customers";

const FREE_BILLING_PROFILE_NAME = "pymthouse-free";

let cachedFreeBillingProfileId: string | null = null;

function billingProfileAppId(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === "string" && id.trim()) {
      return id.trim();
    }
  }
  return null;
}

function profileUsesApp(profile: { apps?: unknown }, appId: string): boolean {
  const apps = profile.apps as Record<string, unknown> | undefined;
  if (!apps) {
    return false;
  }
  for (const slot of ["tax", "invoicing", "payment"] as const) {
    if (billingProfileAppId(apps[slot]) !== appId) {
      return false;
    }
  }
  return true;
}

async function findInstalledSandboxAppId(client: OpenMeter): Promise<string> {
  const listed = await client.apps.list({ page: 1, pageSize: 100 });
  const sandbox = listed?.items?.find((app) => app.type === "sandbox");
  if (!sandbox?.id) {
    throw new Error(
      "OpenMeter sandbox app is not installed; install it in Konnect or set OPENMETER_FREE_BILLING_PROFILE_ID",
    );
  }
  return sandbox.id;
}

async function findBillingProfileForSandboxApp(
  client: OpenMeter,
  sandboxAppId: string,
): Promise<string | null> {
  let page = 1;
  const pageSize = 100;
  for (;;) {
    const listed = await client.billing.profiles.list({ page, pageSize });
    const items = listed?.items ?? [];
    for (const profile of items) {
      if (profile.id && profileUsesApp(profile, sandboxAppId)) {
        return profile.id;
      }
    }
    if (!listed || items.length < pageSize) {
      break;
    }
    page += 1;
  }
  return null;
}

export async function getAppBillingConfig(clientId: string) {
  const rows = await db
    .select()
    .from(appBillingConfig)
    .where(eq(appBillingConfig.clientId, clientId))
    .limit(1);
  return rows[0] ?? null;
}

/** Stripe Connect completed and wired into OpenMeter billing profiles. */
export async function isStripeBillingEnabledForApp(clientId: string): Promise<boolean> {
  const config = await getAppBillingConfig(clientId);
  return (
    config?.stripeConnectStatus === "connected" &&
    Boolean(config.openmeterStripeAppId?.trim()) &&
    Boolean(config.openmeterBillingProfileId?.trim())
  );
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

/**
 * Namespace-level sandbox billing profile for free Starter subscriptions.
 * Avoids Konnect's default Stripe-backed profile, which rejects customers
 * without Stripe app data.
 */
export async function ensureFreeBillingProfile(client?: OpenMeter): Promise<string> {
  const fromEnv = process.env.OPENMETER_FREE_BILLING_PROFILE_ID?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  if (cachedFreeBillingProfileId) {
    return cachedFreeBillingProfileId;
  }

  const omClient = client ?? getHostedAdminClient();
  const sandboxAppId = await findInstalledSandboxAppId(omClient);
  const existing = await findBillingProfileForSandboxApp(omClient, sandboxAppId);
  if (existing) {
    cachedFreeBillingProfileId = existing;
    return existing;
  }

  const profile = await omClient.billing.profiles.create({
    name: FREE_BILLING_PROFILE_NAME,
    default: false,
    supplier: {
      name: "PymtHouse Free",
    },
    workflow: {
      invoicing: { autoAdvance: true, draftPeriod: "P0D" },
      payment: { collectionMethod: "charge_automatically" },
    },
    apps: {
      tax: sandboxAppId,
      invoicing: sandboxAppId,
      payment: sandboxAppId,
    },
  });
  if (!profile?.id) {
    throw new Error("Failed to create OpenMeter free (sandbox) billing profile");
  }
  cachedFreeBillingProfileId = profile.id;
  return profile.id;
}

export async function applyFreeBillingProfileToCustomer(input: {
  client: OpenMeter;
  customerId: string;
}): Promise<void> {
  const profileId = await ensureFreeBillingProfile();
  await assignCustomerBillingProfileOverride({
    client: input.client,
    customerId: input.customerId,
    billingProfileId: profileId,
  });
}

export async function applyTenantBillingProfileToCustomer(input: {
  client: OpenMeter;
  clientId: string;
  customerId: string;
}): Promise<void> {
  const config = await getAppBillingConfig(input.clientId);
  if (
    config?.stripeConnectStatus !== "connected" ||
    !config.openmeterStripeAppId?.trim() ||
    !config.openmeterBillingProfileId?.trim()
  ) {
    return;
  }
  await assignCustomerBillingProfileOverride({
    client: input.client,
    customerId: input.customerId,
    billingProfileId: config.openmeterBillingProfileId,
  });
}

export function resetFreeBillingProfileCacheForTests(): void {
  cachedFreeBillingProfileId = null;
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
