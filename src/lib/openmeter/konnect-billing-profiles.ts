import { konnectAdminConfig, konnectAdminFetch } from "./konnect-admin-client";
import { buildKonnectCollectionSettings } from "./billing-collection";
import {
  type BillingProfileSupplierInput,
  buildKonnectSupplierAddress,
} from "./billing-supplier";

type KonnectCollectionSettings = ReturnType<
  typeof buildKonnectCollectionSettings
>;

type KonnectPage<T> = {
  data?: T[];
  meta?: {
    page?: {
      number?: number;
      size?: number;
      total?: number;
    };
  };
};

export type KonnectBillingApp = {
  id: string;
  type?: string;
  status?: string;
  name?: string;
  definition?: { type?: string };
};

export type KonnectBillingProfileListItem = {
  id: string;
  name?: string;
  apps?: {
    tax?: { id?: string };
    invoicing?: { id?: string };
    payment?: { id?: string };
  };
};

type KonnectBillingProfile = {
  id: string;
};

export type KonnectCreateBillingProfileBody = {
  name: string;
  default: boolean;
  supplier: {
    name: string;
    addresses: {
      billing_address: Record<string, string>;
    };
    tax_id?: { code: string };
  };
  workflow: {
    collection?: KonnectCollectionSettings;
    invoicing: {
      auto_advance: boolean;
      draft_period: string;
      progressive_billing?: boolean;
    };
    payment: { collection_method: "charge_automatically" | "send_invoice" };
  };
  apps: {
    tax: { id: string };
    invoicing: { id: string };
    payment: { id: string };
  };
};

const KONNECT_STRIPE_INSTALL_DOCS =
  "https://developer.konghq.com/metering-and-billing/stripe-integration/";

function buildKonnectSupplier(
  name: string,
  supplier?: BillingProfileSupplierInput,
): KonnectCreateBillingProfileBody["supplier"] {
  const taxId = supplier?.taxId?.trim();
  return {
    name,
    addresses: { billing_address: buildKonnectSupplierAddress(supplier) },
    ...(taxId ? { tax_id: { code: taxId } } : {}),
  };
}

function billingFetch<T>(path: string, init?: RequestInit): Promise<T> {
  return konnectAdminFetch<T>(path, init, "billing");
}

export function konnectAppType(app: KonnectBillingApp): string {
  return (app.type ?? app.definition?.type ?? "").toLowerCase();
}

export function isKonnectStripeAppReady(app: KonnectBillingApp): boolean {
  return konnectAppType(app) === "stripe" && (app.status ?? "ready") === "ready";
}

export function isKonnectStripeAppUnauthorized(app: KonnectBillingApp): boolean {
  return konnectAppType(app) === "stripe" && app.status === "unauthorized";
}

export function isKonnectCustomInvoicingApp(app: KonnectBillingApp): boolean {
  return konnectAppType(app) === "custom_invoicing";
}

export function selectReadyKonnectStripeApp(apps: KonnectBillingApp[]): string | null {
  const stripe = apps.find((app) => isKonnectStripeAppReady(app));
  return stripe?.id ?? null;
}

export function selectKonnectCustomInvoicingApp(
  apps: KonnectBillingApp[],
): string | null {
  const ready = apps.find(
    (app) => isKonnectCustomInvoicingApp(app) && app.status === "ready",
  );
  if (ready?.id) return ready.id;
  // Some installs omit status; accept those, but never unauthorized.
  const fallback = apps.find(
    (app) =>
      isKonnectCustomInvoicingApp(app) && app.status !== "unauthorized",
  );
  return fallback?.id ?? null;
}

function uniqueAppIdsFromProfiles(profiles: KonnectBillingProfileListItem[]): string[] {
  const ids = new Set<string>();
  for (const profile of profiles) {
    for (const slot of [
      profile.apps?.tax?.id,
      profile.apps?.invoicing?.id,
      profile.apps?.payment?.id,
    ]) {
      const id = slot?.trim();
      if (id) {
        ids.add(id);
      }
    }
  }
  return [...ids];
}

function formatKonnectAppSummary(apps: KonnectBillingApp[]): string {
  if (apps.length === 0) {
    return "none";
  }
  return apps
    .map((app) => {
      const type = konnectAppType(app) || "unknown";
      const status = app.status ?? "unknown";
      const label = app.name?.trim() || app.id;
      return `${type} (${status}, ${label})`;
    })
    .join("; ");
}

export async function getKonnectApp(appId: string): Promise<KonnectBillingApp | null> {
  try {
    return await billingFetch<KonnectBillingApp>(
      `/apps/${encodeURIComponent(appId)}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("(404)")) {
      return null;
    }
    throw err;
  }
}

export async function listKonnectBillingProfiles(): Promise<KonnectBillingProfileListItem[]> {
  const profiles: KonnectBillingProfileListItem[] = [];
  let pageNumber = 1;
  const pageSize = 100;

  while (true) {
    const params = new URLSearchParams();
    params.set("page[number]", String(pageNumber));
    params.set("page[size]", String(pageSize));
    const page = await billingFetch<KonnectPage<KonnectBillingProfileListItem>>(
      `/profiles?${params.toString()}`,
    );
    const batch = page.data ?? [];
    profiles.push(...batch);

    const total = page.meta?.page?.total;
    if (batch.length < pageSize || (total !== undefined && profiles.length >= total)) {
      break;
    }
    pageNumber += 1;
  }

  return profiles;
}

async function resolveStripeAppFromBillingProfiles(): Promise<string | null> {
  const profiles = await listKonnectBillingProfiles();
  const candidateIds = uniqueAppIdsFromProfiles(profiles);

  for (const appId of candidateIds) {
    const app = await getKonnectApp(appId);
    if (app && isKonnectStripeAppReady(app)) {
      return app.id;
    }
  }
  return null;
}

export async function listKonnectApps(): Promise<KonnectBillingApp[]> {
  const apps: KonnectBillingApp[] = [];
  let pageNumber = 1;
  const pageSize = 100;

  while (true) {
    const params = new URLSearchParams();
    params.set("page[number]", String(pageNumber));
    params.set("page[size]", String(pageSize));
    const page = await billingFetch<KonnectPage<KonnectBillingApp>>(
      `/apps?${params.toString()}`,
    );
    const batch = page.data ?? [];
    apps.push(...batch);

    const total = page.meta?.page?.total;
    if (batch.length < pageSize || (total !== undefined && apps.length >= total)) {
      break;
    }
    pageNumber += 1;
  }

  return apps;
}

export function buildKonnectCreateBillingProfileBody(input: {
  clientId: string;
  stripeAppId: string;
  name?: string;
  progressiveBilling?: boolean;
  supplier?: BillingProfileSupplierInput;
  collectionAnchor?: Date;
}): KonnectCreateBillingProfileBody {
  const supplierName = input.name || `Tenant ${input.clientId}`;
  return {
    name: input.name || `pymthouse-${input.clientId}`,
    default: false,
    supplier: buildKonnectSupplier(supplierName, input.supplier),
    workflow: {
      collection: buildKonnectCollectionSettings(input.collectionAnchor),
      invoicing: {
        auto_advance: true,
        draft_period: "P0D",
        progressive_billing: input.progressiveBilling ?? true,
      },
      payment: { collection_method: "charge_automatically" },
    },
    apps: {
      tax: { id: input.stripeAppId },
      invoicing: { id: input.stripeAppId },
      payment: { id: input.stripeAppId },
    },
  };
}

/**
 * Merchant-plane profile: tax / invoicing / payment all point at the Custom
 * Invoicing app so OM pauses for pymthouse Connect collection.
 */
export function buildKonnectMerchantCustomInvoicingProfileBody(input: {
  customInvoicingAppId: string;
  name?: string;
  progressiveBilling?: boolean;
  collectionMethod?: "charge_automatically" | "send_invoice";
  supplier?: BillingProfileSupplierInput;
  collectionAnchor?: Date;
}): KonnectCreateBillingProfileBody {
  const appId = input.customInvoicingAppId;
  const supplierName = input.name || "PymtHouse Merchant";
  return {
    name: input.name || "pymthouse-merchant-custom-invoicing",
    default: false,
    supplier: buildKonnectSupplier(supplierName, input.supplier),
    workflow: {
      collection: buildKonnectCollectionSettings(input.collectionAnchor),
      invoicing: {
        auto_advance: true,
        draft_period: "P0D",
        progressive_billing: input.progressiveBilling ?? true,
      },
      payment: {
        collection_method: input.collectionMethod ?? "charge_automatically",
      },
    },
    apps: {
      tax: { id: appId },
      invoicing: { id: appId },
      payment: { id: appId },
    },
  };
}

export async function resolveKonnectCustomInvoicingAppId(): Promise<string> {
  const override = process.env.OPENMETER_CUSTOM_INVOICING_APP_ID?.trim();
  if (override) {
    const app = await getKonnectApp(override);
    if (!app) {
      throw new Error(
        `OPENMETER_CUSTOM_INVOICING_APP_ID=${override} was not found. ` +
          "Install Custom Invoicing in Konnect → Metering & Billing → Settings → Apps.",
      );
    }
    if (!isKonnectCustomInvoicingApp(app)) {
      throw new Error(
        `OPENMETER_CUSTOM_INVOICING_APP_ID=${override} is type=${konnectAppType(app)}, expected custom_invoicing.`,
      );
    }
    return override;
  }

  const apps = await listKonnectApps();
  const fromApps = selectKonnectCustomInvoicingApp(apps);
  if (fromApps) {
    return fromApps;
  }

  throw new Error(
    "No Custom Invoicing app found in Konnect. Install it via Marketplace " +
      "(type=custom_invoicing) or set OPENMETER_CUSTOM_INVOICING_APP_ID. " +
      `Listed apps: ${formatKonnectAppSummary(apps)}.`,
  );
}

export async function createKonnectMerchantCustomInvoicingProfile(input: {
  customInvoicingAppId: string;
  name?: string;
  progressiveBilling?: boolean;
  collectionMethod?: "charge_automatically" | "send_invoice";
  supplier?: BillingProfileSupplierInput;
}): Promise<string> {
  const body = buildKonnectMerchantCustomInvoicingProfileBody(input);
  const profile = await billingFetch<KonnectBillingProfile>("/profiles", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!profile?.id) {
    throw new Error("Failed to create Konnect merchant Custom Invoicing billing profile");
  }
  return profile.id;
}

export async function resolveKonnectStripeAppId(): Promise<string> {
  const { baseUrl } = konnectAdminConfig();
  const override = process.env.OPENMETER_STRIPE_APP_ID?.trim();
  if (override) {
    const app = await getKonnectApp(override);
    if (!app) {
      throw new Error(
        `OPENMETER_STRIPE_APP_ID=${override} was not found at ${baseUrl}/apps. ` +
          "Use an app id from Konnect → Metering & Billing → Settings → Stripe in the same org/region as OPENMETER_URL.",
      );
    }
    if (!isKonnectStripeAppReady(app)) {
      const type = konnectAppType(app) || "unknown";
      const status = app.status ?? "unknown";
      throw new Error(
        `OPENMETER_STRIPE_APP_ID=${override} is ${type} (${status}), not a ready Stripe app. ` +
          "Re-install Stripe in Konnect or pick the Stripe app id from Settings → Stripe.",
      );
    }
    return override;
  }

  const apps = await listKonnectApps();
  const fromApps = selectReadyKonnectStripeApp(apps);
  if (fromApps) {
    return fromApps;
  }

  const unauthorizedStripe = apps.find((app) => isKonnectStripeAppUnauthorized(app));
  if (unauthorizedStripe?.id) {
    throw new Error(
      "Konnect Stripe app is installed but unauthorized (invalid or revoked API key). " +
        "Re-install Stripe in Konnect → Metering & Billing → Settings → Stripe " +
        `(see ${KONNECT_STRIPE_INSTALL_DOCS}).`,
    );
  }

  const fromProfiles = await resolveStripeAppFromBillingProfiles();
  if (fromProfiles) {
    return fromProfiles;
  }

  throw new Error(
    "No ready Stripe app found in Konnect. Install Stripe in Konnect → Metering & Billing → Settings → Stripe " +
      `(see ${KONNECT_STRIPE_INSTALL_DOCS}). ` +
      `Konnect API ${baseUrl} lists: ${formatKonnectAppSummary(apps)}. ` +
      "Ensure OPENMETER_URL and OPENMETER_API_KEY are for the same Konnect org/region where Stripe was installed, " +
      "or set OPENMETER_STRIPE_APP_ID to the Stripe app ULID from Konnect Settings.",
  );
}

export async function createKonnectBillingProfile(input: {
  clientId: string;
  openmeterStripeAppId: string;
  name?: string;
  progressiveBilling?: boolean;
  supplier?: BillingProfileSupplierInput;
}): Promise<string> {
  const body = buildKonnectCreateBillingProfileBody({
    clientId: input.clientId,
    stripeAppId: input.openmeterStripeAppId,
    name: input.name,
    progressiveBilling: input.progressiveBilling,
    supplier: input.supplier,
  });
  const profile = await billingFetch<KonnectBillingProfile>("/profiles", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!profile?.id) {
    throw new Error("Failed to create Konnect billing profile");
  }
  return profile.id;
}

/** Read-modify-write of an existing Konnect billing profile's workflow block. */
async function patchKonnectBillingProfileWorkflow(
  profileId: string,
  mutate: (workflow: Record<string, unknown>) => void,
): Promise<void> {
  const existing = await billingFetch<Record<string, unknown>>(
    `/profiles/${encodeURIComponent(profileId)}`,
  );
  if (!existing || typeof existing !== "object") {
    throw new Error("Konnect billing profile not found");
  }

  const workflow =
    existing.workflow && typeof existing.workflow === "object"
      ? { ...(existing.workflow as Record<string, unknown>) }
      : {};
  mutate(workflow);

  const {
    id: _id,
    created_at: _createdAt,
    updated_at: _updatedAt,
    deleted_at: _deletedAt,
    apps: _apps,
    ...replaceable
  } = existing;

  await billingFetch(`/profiles/${encodeURIComponent(profileId)}`, {
    method: "PUT",
    body: JSON.stringify({
      ...replaceable,
      workflow,
    }),
  });
}

/** Patch invoicing.progressive_billing on an existing Konnect billing profile. */
export async function updateKonnectBillingProfileProgressiveBilling(input: {
  profileId: string;
  progressiveBilling: boolean;
}): Promise<void> {
  await patchKonnectBillingProfileWorkflow(input.profileId, (workflow) => {
    const invoicing =
      workflow.invoicing && typeof workflow.invoicing === "object"
        ? { ...(workflow.invoicing as Record<string, unknown>) }
        : {};
    invoicing.progressive_billing = input.progressiveBilling;
    workflow.invoicing = invoicing;
  });
}

/** Move an existing Konnect profile onto anchored daily collection. */
export async function updateKonnectBillingProfileCollection(input: {
  profileId: string;
  anchor?: Date;
}): Promise<void> {
  await patchKonnectBillingProfileWorkflow(input.profileId, (workflow) => {
    workflow.collection = buildKonnectCollectionSettings(input.anchor);
  });
}

/** Replace the supplier on an existing Konnect billing profile (read-modify-write). */
export async function updateKonnectBillingProfileSupplier(input: {
  profileId: string;
  name: string;
  supplier?: BillingProfileSupplierInput;
}): Promise<void> {
  const existing = await billingFetch<Record<string, unknown>>(
    `/profiles/${encodeURIComponent(input.profileId)}`,
  );
  if (!existing || typeof existing !== "object") {
    throw new Error("Konnect billing profile not found");
  }

  const {
    id: _id,
    created_at: _createdAt,
    updated_at: _updatedAt,
    deleted_at: _deletedAt,
    apps: _apps,
    ...replaceable
  } = existing;

  await billingFetch(`/profiles/${encodeURIComponent(input.profileId)}`, {
    method: "PUT",
    body: JSON.stringify({
      ...replaceable,
      supplier: buildKonnectSupplier(input.name, input.supplier),
    }),
  });
}
