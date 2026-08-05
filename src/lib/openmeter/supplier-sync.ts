/**
 * Sync Stripe Connect merchant identity onto app_billing_config and the
 * OpenMeter / Konnect billing profile supplier.
 *
 * Invoices clone the profile at creation and are immutable — keep the supplier
 * correct before the first merchant invoice, and re-sync on account.updated.
 */
import { getHostedAdminClient } from "./admin-client";
import {
  getAppBillingConfig,
  upsertAppBillingConfig,
} from "./billing-profiles";
import {
  type BillingProfileSupplierInput,
  type SupplierGap,
  buildOpenMeterSupplierAddress,
  requiresSupplierTaxId,
  supplierGaps,
  supplierIsComplete,
} from "./billing-supplier";
import { getHostedOpenMeterUrl } from "./constants";
import {
  updateKonnectBillingProfileSupplier,
} from "./konnect-billing-profiles";
import { shouldUseKonnectRoutes } from "./route-mode";
import {
  type ConnectedAccountIdentity,
  fetchConnectedAccountIdentity,
} from "@/lib/stripe/connect-accounts";

export function supplierFromBillingConfig(config: {
  supplierCountry?: string | null;
  supplierAddressLine1?: string | null;
  supplierAddressLine2?: string | null;
  supplierAddressCity?: string | null;
  supplierAddressState?: string | null;
  supplierAddressPostalCode?: string | null;
  supplierTaxId?: string | null;
}): BillingProfileSupplierInput {
  return {
    country: config.supplierCountry,
    addressLine1: config.supplierAddressLine1,
    addressLine2: config.supplierAddressLine2,
    addressCity: config.supplierAddressCity,
    addressState: config.supplierAddressState,
    addressPostalCode: config.supplierAddressPostalCode,
    taxId: config.supplierTaxId,
  };
}

export function supplierDisplayName(config: {
  clientId: string;
  supplierName?: string | null;
}): string {
  const name = config.supplierName?.trim();
  return name || `Tenant ${config.clientId}`;
}

export async function appSupplierGaps(
  clientId: string,
): Promise<SupplierGap[]> {
  const config = await getAppBillingConfig(clientId);
  if (!config) {
    return ["country", "name"];
  }
  return supplierGaps({
    country: config.supplierCountry,
    name: config.supplierName,
    taxId: config.supplierTaxId,
  });
}

export async function syncSupplierToOpenMeterProfile(input: {
  profileId: string;
  name: string;
  supplier?: BillingProfileSupplierInput;
}): Promise<void> {
  const useKonnect = shouldUseKonnectRoutes(
    getHostedOpenMeterUrl(),
    process.env.OPENMETER_API_KEY,
  );
  if (useKonnect) {
    await updateKonnectBillingProfileSupplier({
      profileId: input.profileId,
      name: input.name,
      supplier: input.supplier,
    });
    return;
  }

  const client = getHostedAdminClient();
  const profile = await client.billing.profiles.get(input.profileId);
  if (!profile?.id) {
    throw new Error("OpenMeter billing profile not found");
  }

  const taxId = input.supplier?.taxId?.trim();
  await client.billing.profiles.update(input.profileId, {
    name: profile.name,
    default: profile.default ?? false,
    supplier: {
      name: input.name,
      addresses: [buildOpenMeterSupplierAddress(input.supplier)],
      ...(taxId ? { taxId: { code: taxId } } : {}),
    },
    workflow: profile.workflow,
    apps: profile.apps,
  } as Parameters<typeof client.billing.profiles.update>[1]);
}

function preferredMerchantProfileId(config: {
  openmeterMerchantBillingProfileId?: string | null;
  openmeterBillingProfileId?: string | null;
}): string | null {
  return (
    config.openmeterMerchantBillingProfileId?.trim() ||
    config.openmeterBillingProfileId?.trim() ||
    null
  );
}

export type SyncTenantSupplierResult = {
  status:
    | "synced"
    | "onboarding_incomplete"
    | "no_account"
    | "pushed_partial";
  gaps: SupplierGap[];
};

/**
 * Fetch Connect identity, persist columns, push to the billing profile.
 * Never overwrites developer-supplied supplierTaxId.
 */
export async function syncTenantSupplierFromConnect(input: {
  clientId: string;
  accountId?: string;
  identity?: ConnectedAccountIdentity;
}): Promise<SyncTenantSupplierResult> {
  const config = await getAppBillingConfig(input.clientId);
  if (!config) {
    return { status: "no_account", gaps: ["country", "name"] };
  }

  const accountId =
    input.accountId?.trim() ||
    config.stripeConnectedAccountId?.trim() ||
    "";
  if (!accountId) {
    return { status: "no_account", gaps: ["country", "name"] };
  }

  const identity =
    input.identity ?? (await fetchConnectedAccountIdentity(accountId));

  // Bail when onboarding has not produced a country yet — avoid blanking a
  // good supplier during re-onboarding.
  if (!identity.detailsSubmitted && !identity.country) {
    return {
      status: "onboarding_incomplete",
      gaps: supplierGaps({
        country: config.supplierCountry,
        name: config.supplierName,
        taxId: config.supplierTaxId,
      }),
    };
  }

  const country = identity.country || config.supplierCountry || null;
  const supplierName = identity.legalName || config.supplierName || null;

  await upsertAppBillingConfig(input.clientId, {
    supplierCountry: country,
    supplierName,
    supplierBusinessType: identity.businessType,
    supplierAddressLine1: identity.addressLine1,
    supplierAddressLine2: identity.addressLine2,
    supplierAddressCity: identity.addressCity,
    supplierAddressState: identity.addressState,
    supplierAddressPostalCode: identity.addressPostalCode,
    supplierTaxIdOnFileAtStripe: identity.taxIdProvided,
    // Never overwrite developer-supplied tax id.
    supplierSyncedAt: new Date().toISOString(),
  });

  const refreshed = await getAppBillingConfig(input.clientId);
  const supplier = supplierFromBillingConfig(refreshed ?? config);
  const name = supplierDisplayName({
    clientId: input.clientId,
    supplierName: refreshed?.supplierName ?? supplierName,
  });
  const gaps = supplierGaps({
    country: refreshed?.supplierCountry ?? country,
    name: refreshed?.supplierName ?? supplierName,
    taxId: refreshed?.supplierTaxId,
  });

  const profileId = preferredMerchantProfileId(refreshed ?? config);
  if (profileId) {
    await syncSupplierToOpenMeterProfile({
      profileId,
      name,
      supplier,
    });
  }

  return {
    status: gaps.length === 0 ? "synced" : "pushed_partial",
    gaps,
  };
}

export async function setAppSupplierTaxId(input: {
  clientId: string;
  taxId: string | null;
}): Promise<SyncTenantSupplierResult> {
  const trimmed = input.taxId?.trim() || null;
  await upsertAppBillingConfig(input.clientId, {
    supplierTaxId: trimmed,
  });

  const config = await getAppBillingConfig(input.clientId);
  if (!config) {
    return { status: "no_account", gaps: ["country", "name"] };
  }

  const supplier = supplierFromBillingConfig(config);
  const name = supplierDisplayName(config);
  const gaps = supplierGaps({
    country: config.supplierCountry,
    name: config.supplierName,
    taxId: config.supplierTaxId,
  });

  const profileId = preferredMerchantProfileId(config);
  if (profileId) {
    await syncSupplierToOpenMeterProfile({
      profileId,
      name,
      supplier,
    });
  }

  return {
    status: gaps.length === 0 ? "synced" : "pushed_partial",
    gaps,
  };
}

/** Prefer direct when supplier is complete; otherwise destination (platform MoR). */
export function resolveMerchantChargeModel(config: {
  supplierCountry?: string | null;
  supplierName?: string | null;
  supplierTaxId?: string | null;
}): "direct" | "destination" {
  if (
    supplierIsComplete({
      country: config.supplierCountry,
      name: config.supplierName,
      taxId: config.supplierTaxId,
    })
  ) {
    return "direct";
  }
  return "destination";
}

export function supplierStatusPayload(config: {
  supplierCountry?: string | null;
  supplierName?: string | null;
  supplierTaxId?: string | null;
  supplierTaxIdOnFileAtStripe?: boolean | null;
  supplierSyncedAt?: string | null;
  supplierBusinessType?: string | null;
}) {
  const gaps = supplierGaps({
    country: config.supplierCountry,
    name: config.supplierName,
    taxId: config.supplierTaxId,
  });
  return {
    supplierCountry: config.supplierCountry ?? null,
    supplierName: config.supplierName ?? null,
    supplierBusinessType: config.supplierBusinessType ?? null,
    supplierTaxId: config.supplierTaxId ?? null,
    supplierTaxIdOnFileAtStripe: Boolean(config.supplierTaxIdOnFileAtStripe),
    supplierTaxIdRequired: requiresSupplierTaxId(config.supplierCountry),
    supplierSyncedAt: config.supplierSyncedAt ?? null,
    supplierGaps: gaps,
    supplierComplete: gaps.length === 0,
  };
}
