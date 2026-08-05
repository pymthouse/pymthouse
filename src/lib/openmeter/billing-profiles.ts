import {
  platformDefaultApplicationFeeBps,
  platformDefaultEndUserCap,
} from "@/lib/billing/platform-billing-defaults";
import { sanitizeForLog } from "@/lib/sanitize-for-log";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/db/index";
import { appBillingConfig } from "@/db/schema";
import type { OpenMeter } from "@openmeter/sdk";
import { getHostedAdminClient } from "./admin-client";
import { assignCustomerBillingProfileOverride } from "./customers";
import {
  createKonnectBillingProfile,
  resolveKonnectStripeAppId,
  updateKonnectBillingProfileProgressiveBilling,
} from "./konnect-billing-profiles";
import { getHostedOpenMeterUrl } from "./constants";
import { shouldUseKonnectRoutes } from "./route-mode";
import {
  type BillingProfileSupplierInput,
  buildOpenMeterSupplierAddress,
} from "./billing-supplier";
import {
  ensureKonnectCustomerStripeBilling,
  ensureStripeCustomerAppData,
  setKonnectCustomerBillingProfile,
} from "./stripe-customer-data";

export type { BillingProfileSupplierInput } from "./billing-supplier";

export function buildBillingProfileSupplier(
  displayName: string,
  supplier?: BillingProfileSupplierInput,
) {
  const taxId = supplier?.taxId?.trim();
  return {
    name: displayName,
    addresses: [buildOpenMeterSupplierAddress(supplier)],
    ...(taxId ? { taxId: { code: taxId } } : {}),
  };
}

const OWNERS_BILLING_PROFILE_NAME = "pymthouse-owners";
const OWNERS_PROFILE_CLIENT_KEY = "owners";
const FREE_BILLING_PROFILE_NAME = "pymthouse-free";

let cachedOwnersBillingProfileId: string | null = null;
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

async function findBillingProfileByName(
  client: OpenMeter,
  name: string,
): Promise<string | null> {
  let page = 1;
  const pageSize = 100;
  for (;;) {
    const listed = await client.billing.profiles.list({ page, pageSize });
    const items = listed?.items ?? [];
    for (const profile of items) {
      if (profile.id && profile.name === name) {
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

async function resolveSelfHostedStripeAppId(client: OpenMeter): Promise<string> {
  const listed = await client.apps.list({ page: 1, pageSize: 100 });
  const stripe = (listed?.items ?? []).find((app) => app.type === "stripe");
  if (!stripe?.id) {
    throw new Error(
      "No Stripe app installed in OpenMeter. Install Stripe (marketplace API key or OAuth) before provisioning billing.",
    );
  }
  return stripe.id;
}

async function resolvePlatformStripeAppId(client?: OpenMeter): Promise<string> {
  const useKonnect = shouldUseKonnectRoutes(
    getHostedOpenMeterUrl(),
    process.env.OPENMETER_API_KEY,
  );
  if (useKonnect) {
    return resolveKonnectStripeAppId();
  }
  return resolveSelfHostedStripeAppId(client ?? getHostedAdminClient());
}

export async function getAppBillingConfig(clientId: string) {
  const rows = await db
    .select()
    .from(appBillingConfig)
    .where(eq(appBillingConfig.clientId, clientId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Platform OpenMeter Stripe billing is ready (Plane A): org Stripe app +
 * tenant billing profile. Distinct from merchant Stripe Connect readiness.
 */
export function isAppBillingReady(
  config: {
    openmeterStripeAppId?: string | null;
    openmeterBillingProfileId?: string | null;
  } | null | undefined,
): boolean {
  return (
    Boolean(config?.openmeterStripeAppId?.trim()) &&
    Boolean(config?.openmeterBillingProfileId?.trim())
  );
}

/** @deprecated Prefer {@link isAppBillingReady}; name kept for existing call sites. */
export async function isStripeBillingEnabledForApp(clientId: string): Promise<boolean> {
  const config = await getAppBillingConfig(clientId);
  return isAppBillingReady(config);
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

  const profileName = input.name || `pymthouse-${input.clientId}`;
  const supplierName = input.name || `Tenant ${input.clientId}`;
  const useKonnect = shouldUseKonnectRoutes(
    getHostedOpenMeterUrl(),
    process.env.OPENMETER_API_KEY,
  );

  const progressiveBilling = existing?.progressiveBilling ?? true;

  const profileId = useKonnect
    ? await createKonnectBillingProfile({
        clientId: input.clientId,
        openmeterStripeAppId: input.openmeterStripeAppId,
        name: profileName,
        progressiveBilling,
      })
    : (
        await client.billing.profiles.create({
          name: profileName,
          default: false,
          supplier: buildBillingProfileSupplier(supplierName),
          workflow: {
            invoicing: {
              autoAdvance: true,
              draftPeriod: "P0D",
              progressiveBilling,
            },
            payment: { collectionMethod: "charge_automatically" },
          },
          apps: {
            tax: input.openmeterStripeAppId,
            invoicing: input.openmeterStripeAppId,
            payment: input.openmeterStripeAppId,
          },
        })
      )?.id;

  if (!profileId) {
    throw new Error("Failed to create OpenMeter billing profile");
  }

  const now = new Date().toISOString();
  if (existing) {
    await db
      .update(appBillingConfig)
      .set({
        openmeterBillingProfileId: profileId,
        updatedAt: now,
      })
      .where(eq(appBillingConfig.clientId, input.clientId));
  }

  return profileId;
}

/**
 * Ensure this developer app has a Stripe-backed billing profile (shared org Stripe app).
 * Replaces the need for a manual Connect click before Starter provision.
 */
export async function ensureAppStripeBillingReady(input: {
  clientId: string;
  name?: string;
}): Promise<{
  openmeterStripeAppId: string;
  openmeterBillingProfileId: string;
}> {
  const existing = await getAppBillingConfig(input.clientId);
  const existingStripeAppId = existing?.openmeterStripeAppId?.trim();
  const existingProfileId = existing?.openmeterBillingProfileId?.trim();
  if (existingStripeAppId && existingProfileId) {
    return {
      openmeterStripeAppId: existingStripeAppId,
      openmeterBillingProfileId: existingProfileId,
    };
  }

  const client = getHostedAdminClient();
  const stripeAppId =
    existing?.openmeterStripeAppId?.trim() ||
    (await resolvePlatformStripeAppId(client));
  const profileId = await ensureTenantBillingProfile({
    clientId: input.clientId,
    openmeterStripeAppId: stripeAppId,
    name: input.name,
  });
  const now = new Date().toISOString();
  await upsertAppBillingConfig(input.clientId, {
    stripeConnectStatus: "connected",
    openmeterStripeAppId: stripeAppId,
    openmeterBillingProfileId: profileId,
    connectedAt: existing?.connectedAt ?? now,
  });
  return {
    openmeterStripeAppId: stripeAppId,
    openmeterBillingProfileId: profileId,
  };
}

/** Shared Stripe billing profile for platform owner customers. */
export async function ensureOwnersBillingProfile(
  client?: OpenMeter,
): Promise<string> {
  const fromEnv = process.env.OPENMETER_OWNERS_BILLING_PROFILE_ID?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  if (cachedOwnersBillingProfileId) {
    return cachedOwnersBillingProfileId;
  }

  const omClient = client ?? getHostedAdminClient();
  const byName = await findBillingProfileByName(
    omClient,
    OWNERS_BILLING_PROFILE_NAME,
  );
  if (byName) {
    cachedOwnersBillingProfileId = byName;
    return byName;
  }

  const stripeAppId = await resolvePlatformStripeAppId(omClient);
  const useKonnect = shouldUseKonnectRoutes(
    getHostedOpenMeterUrl(),
    process.env.OPENMETER_API_KEY,
  );
  const profileId = useKonnect
    ? await createKonnectBillingProfile({
        clientId: OWNERS_PROFILE_CLIENT_KEY,
        openmeterStripeAppId: stripeAppId,
        name: OWNERS_BILLING_PROFILE_NAME,
        progressiveBilling: true,
      })
    : (
        await omClient.billing.profiles.create({
          name: OWNERS_BILLING_PROFILE_NAME,
          default: false,
          supplier: buildBillingProfileSupplier("PymtHouse Owners"),
          workflow: {
            invoicing: {
              autoAdvance: true,
              draftPeriod: "P0D",
              progressiveBilling: true,
            },
            payment: { collectionMethod: "charge_automatically" },
          },
          apps: {
            tax: stripeAppId,
            invoicing: stripeAppId,
            payment: stripeAppId,
          },
        })
      )?.id;

  if (!profileId) {
    throw new Error("Failed to create owners Stripe billing profile");
  }
  cachedOwnersBillingProfileId = profileId;
  return profileId;
}

/**
 * Provision Stripe customer app data + pin customer to the app Stripe billing profile.
 */
export async function prepareAppCustomerStripeBilling(input: {
  client: OpenMeter;
  clientId: string;
  customerId: string;
  customerKey?: string;
  name?: string;
}): Promise<void> {
  const config = await getAppBillingConfig(input.clientId);
  const merchantProfileId =
    config?.openmeterMerchantBillingProfileId?.trim() ||
    process.env.OPENMETER_MERCHANT_BILLING_PROFILE_ID?.trim() ||
    null;

  // Merchant plane: pin to Custom Invoicing profile (no platform Stripe charge).
  if (config?.billingMode === "merchant") {
    if (!merchantProfileId) {
      throw new Error(
        "OPENMETER_MERCHANT_BILLING_PROFILE_ID (or app openmeterMerchantBillingProfileId) is required when billingMode=merchant",
      );
    }
    await assignMerchantCustomInvoicingProfile({
      client: input.client,
      customerId: input.customerId,
      billingProfileId: merchantProfileId,
    });
    const accountId = config.stripeConnectedAccountId?.trim();
    if (accountId) {
      const { resolveMerchantChargeModel } = await import("./supplier-sync");
      const { merchantSettlementMetadata } = await import(
        "./settlement-metadata"
      );
      const { ensureCustomerMetadata } = await import("./customers");
      const chargeModel = resolveMerchantChargeModel(config);
      if (chargeModel !== "direct") {
        console.warn(
          "merchant customer settlement metadata: supplier incomplete; using destination",
          sanitizeForLog(input.clientId),
        );
      }
      await ensureCustomerMetadata(
        input.client,
        input.customerId,
        merchantSettlementMetadata({
          connectedAccountId: accountId,
          chargeModel,
        }),
      );
    }
    return;
  }

  const ready = await ensureAppStripeBillingReady({ clientId: input.clientId });
  const useKonnect = shouldUseKonnectRoutes(
    getHostedOpenMeterUrl(),
    process.env.OPENMETER_API_KEY,
  );
  if (useKonnect) {
    await ensureKonnectCustomerStripeBilling({
      customerId: input.customerId,
      customerKey: input.customerKey,
      name: input.name,
      billingProfileId: ready.openmeterBillingProfileId,
    });
    return;
  }
  await ensureStripeCustomerAppData({
    client: input.client,
    customerId: input.customerId,
    customerKey: input.customerKey,
    name: input.name,
  });
  await assignCustomerBillingProfileOverride({
    client: input.client,
    customerId: input.customerId,
    billingProfileId: ready.openmeterBillingProfileId,
  });
}

/**
 * Provision Stripe customer app data + pin owner customer to the owners Stripe profile.
 */
export async function prepareOwnerCustomerStripeBilling(input: {
  client: OpenMeter;
  customerId: string;
  customerKey?: string;
  name?: string;
}): Promise<void> {
  const profileId = await ensureOwnersBillingProfile(input.client);
  const useKonnect = shouldUseKonnectRoutes(
    getHostedOpenMeterUrl(),
    process.env.OPENMETER_API_KEY,
  );
  if (useKonnect) {
    await ensureKonnectCustomerStripeBilling({
      customerId: input.customerId,
      customerKey: input.customerKey,
      name: input.name,
      billingProfileId: profileId,
    });
    return;
  }
  await ensureStripeCustomerAppData({
    client: input.client,
    customerId: input.customerId,
    customerKey: input.customerKey,
    name: input.name,
  });
  await assignCustomerBillingProfileOverride({
    client: input.client,
    customerId: input.customerId,
    billingProfileId: profileId,
  });
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
    supplier: buildBillingProfileSupplier("PymtHouse Free"),
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

/**
 * Point a customer at the sandbox free billing profile. Callers should only
 * invoke this when subscription create fails with
 * {@link isOpenMeterStripeBillingError} — the default Stripe-backed profile
 * rejects customers without Stripe app data, and this override is the fix.
 * The override persists in Konnect, so once applied it does not need to run
 * again for that customer.
 */
export async function applyFreeBillingProfileToCustomer(input: {
  client: OpenMeter;
  customerId: string;
}): Promise<void> {
  const profileId = await ensureFreeBillingProfile(input.client);
  const useKonnect = shouldUseKonnectRoutes(
    getHostedOpenMeterUrl(),
    process.env.OPENMETER_API_KEY,
  );
  if (useKonnect) {
    await setKonnectCustomerBillingProfile({
      customerId: input.customerId,
      billingProfileId: profileId,
    });
    return;
  }
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
  customerKey?: string;
  name?: string;
}): Promise<void> {
  const ready = await ensureAppStripeBillingReady({ clientId: input.clientId });
  const useKonnect = shouldUseKonnectRoutes(
    getHostedOpenMeterUrl(),
    process.env.OPENMETER_API_KEY,
  );
  if (useKonnect) {
    await ensureKonnectCustomerStripeBilling({
      customerId: input.customerId,
      customerKey: input.customerKey,
      name: input.name,
      billingProfileId: ready.openmeterBillingProfileId,
    });
    return;
  }
  await assignCustomerBillingProfileOverride({
    client: input.client,
    customerId: input.customerId,
    billingProfileId: ready.openmeterBillingProfileId,
  });
}

/**
 * Persist progressive-billing / threshold settings and sync progressiveBilling
 * to the OpenMeter tenant billing profile when connected.
 */
export async function updateAppBillingProfileSettings(input: {
  clientId: string;
  progressiveBilling?: boolean;
  invoiceThresholdUsdMicros?: string | null;
  applicationFeeBps?: number;
}): Promise<{
  progressiveBilling: boolean;
  invoiceThresholdUsdMicros: string | null;
  applicationFeeBps: number;
}> {
  let existing = await getAppBillingConfig(input.clientId);
  if (!existing) {
    await upsertAppBillingConfig(input.clientId, {});
    existing = await getAppBillingConfig(input.clientId);
  }
  if (!existing) {
    throw new Error("Billing is not configured for this app");
  }

  const progressiveBilling =
    input.progressiveBilling === undefined
      ? existing.progressiveBilling
      : input.progressiveBilling;
  const invoiceThresholdUsdMicros =
    input.invoiceThresholdUsdMicros === undefined
      ? existing.invoiceThresholdUsdMicros
      : input.invoiceThresholdUsdMicros;
  const applicationFeeBps =
    input.applicationFeeBps === undefined
      ? (existing.applicationFeeBps ?? 0)
      : input.applicationFeeBps;

  const progressiveChanged =
    input.progressiveBilling !== undefined &&
    input.progressiveBilling !== existing.progressiveBilling;

  if (progressiveChanged && isAppBillingReady(existing)) {
    const profileId = existing.openmeterBillingProfileId?.trim();
    if (profileId) {
      await syncProgressiveBillingToOpenMeterProfile({
        profileId,
        progressiveBilling,
      });
    }
  }

  await upsertAppBillingConfig(input.clientId, {
    progressiveBilling,
    invoiceThresholdUsdMicros,
    applicationFeeBps,
  });

  return {
    progressiveBilling,
    invoiceThresholdUsdMicros: invoiceThresholdUsdMicros ?? null,
    applicationFeeBps,
  };
}

async function syncProgressiveBillingToOpenMeterProfile(input: {
  profileId: string;
  progressiveBilling: boolean;
}): Promise<void> {
  const useKonnect = shouldUseKonnectRoutes(
    getHostedOpenMeterUrl(),
    process.env.OPENMETER_API_KEY,
  );
  if (useKonnect) {
    await updateKonnectBillingProfileProgressiveBilling({
      profileId: input.profileId,
      progressiveBilling: input.progressiveBilling,
    });
    return;
  }

  const client = getHostedAdminClient();
  const profile = await client.billing.profiles.get(input.profileId);
  if (!profile?.id) {
    throw new Error("OpenMeter billing profile not found");
  }

  await client.billing.profiles.update(input.profileId, {
    name: profile.name,
    default: profile.default ?? false,
    supplier: profile.supplier,
    workflow: {
      ...(profile.workflow ?? {}),
      invoicing: {
        ...(profile.workflow?.invoicing ?? {}),
        progressiveBilling: input.progressiveBilling,
      },
    },
  } as Parameters<typeof client.billing.profiles.update>[1]);
}

export function resetOwnersBillingProfileCacheForTests(): void {
  cachedOwnersBillingProfileId = null;
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
    // Cost-rail controls come from platform policy, not from the app. Set
    // explicitly (rather than leaning on the column defaults) so changing
    // policy is an env change instead of a migration. An explicit value in
    // `values` still wins — that path is admin-only.
    endUserCap: platformDefaultEndUserCap(),
    applicationFeeBps: platformDefaultApplicationFeeBps(),
    createdAt: now,
    updatedAt: now,
    ...values,
  });
}

/**
 * Pin an end-user OM customer to the shared merchant Custom Invoicing billing
 * profile (never the org default). Requires OPENMETER_MERCHANT_BILLING_PROFILE_ID.
 */
export async function assignMerchantCustomInvoicingProfile(input: {
  client: OpenMeter;
  customerId: string;
  billingProfileId?: string;
}): Promise<string> {
  const profileId =
    input.billingProfileId?.trim() ||
    process.env.OPENMETER_MERCHANT_BILLING_PROFILE_ID?.trim();
  if (!profileId) {
    throw new Error(
      "OPENMETER_MERCHANT_BILLING_PROFILE_ID is required to assign merchant Custom Invoicing overrides",
    );
  }
  await assignCustomerBillingProfileOverride({
    client: input.client,
    customerId: input.customerId,
    billingProfileId: profileId,
  });
  return profileId;
}
