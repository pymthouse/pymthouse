import {
  getHostedOpenMeterUrl,
  normalizeKonnectMeteringUrl,
} from "./constants";

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
      billing_address: { country: string };
    };
  };
  workflow: {
    invoicing: { auto_advance: boolean; draft_period: string };
    payment: { collection_method: "charge_automatically" };
  };
  apps: {
    tax: { id: string };
    invoicing: { id: string };
    payment: { id: string };
  };
};

const KONNECT_STRIPE_INSTALL_DOCS =
  "https://developer.konghq.com/metering-and-billing/stripe-integration/";

function billingSupplierCountryCode(): string {
  const raw = process.env.OPENMETER_BILLING_SUPPLIER_COUNTRY?.trim() || "US";
  return raw.toUpperCase();
}

function konnectAdminConfig(): { baseUrl: string; apiKey: string } {
  const apiKey = process.env.OPENMETER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENMETER_API_KEY is required for Konnect billing profiles");
  }
  return {
    baseUrl: normalizeKonnectMeteringUrl(getHostedOpenMeterUrl()),
    apiKey,
  };
}

async function konnectAdminFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const { baseUrl, apiKey } = konnectAdminConfig();
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Konnect billing API ${init?.method ?? "GET"} ${path} failed (${response.status}): ${body}`,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
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

export function selectReadyKonnectStripeApp(apps: KonnectBillingApp[]): string | null {
  const stripe = apps.find((app) => isKonnectStripeAppReady(app));
  return stripe?.id ?? null;
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
    return await konnectAdminFetch<KonnectBillingApp>(
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
    const page = await konnectAdminFetch<KonnectPage<KonnectBillingProfileListItem>>(
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
    const page = await konnectAdminFetch<KonnectPage<KonnectBillingApp>>(
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
}): KonnectCreateBillingProfileBody {
  const supplierName = input.name || `Tenant ${input.clientId}`;
  return {
    name: input.name || `pymthouse-${input.clientId}`,
    default: false,
    supplier: {
      name: supplierName,
      addresses: {
        billing_address: { country: billingSupplierCountryCode() },
      },
    },
    workflow: {
      invoicing: { auto_advance: true, draft_period: "P0D" },
      payment: { collection_method: "charge_automatically" },
    },
    apps: {
      tax: { id: input.stripeAppId },
      invoicing: { id: input.stripeAppId },
      payment: { id: input.stripeAppId },
    },
  };
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
}): Promise<string> {
  const body = buildKonnectCreateBillingProfileBody({
    clientId: input.clientId,
    stripeAppId: input.openmeterStripeAppId,
    name: input.name,
  });
  const profile = await konnectAdminFetch<KonnectBillingProfile>("/profiles", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!profile?.id) {
    throw new Error("Failed to create Konnect billing profile");
  }
  return profile.id;
}
