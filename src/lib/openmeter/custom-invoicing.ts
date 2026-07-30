/**
 * OpenMeter / Konnect Custom Invoicing App client.
 *
 * Completes invoice lifecycle pauses at draft.syncing, issuing.syncing, and
 * payment_processing.pending. Paths match OpenMeter OpenAPI and rewrite to
 * Konnect `/apps/custom-invoicing/...` via {@link rewriteKonnectPathname}.
 *
 * @see https://developer.konghq.com/metering-and-billing/custom-invoicing/
 * @see https://openmeter.io/docs/integrations/external-invoicing/overview
 */
import {
  getHostedOpenMeterUrl,
  isKonnectMeteringUrl,
  normalizeKonnectMeteringUrl,
} from "./constants";
import { rewriteKonnectPathname } from "./konnect-routes";

export type CustomInvoicingPaymentTrigger =
  | "paid"
  | "payment_failed"
  | "payment_uncollectible"
  | "payment_overdue"
  | "action_required"
  | "void";

export type CustomInvoicingLineExternalIdMapping = {
  lineId: string;
  externalId: string;
};

export type CustomInvoicingLineDiscountExternalIdMapping = {
  lineDiscountId: string;
  externalId: string;
};

export type CustomInvoicingSyncResult = {
  invoiceNumber?: string;
  externalId?: string;
  lineExternalIds?: CustomInvoicingLineExternalIdMapping[];
  lineDiscountExternalIds?: CustomInvoicingLineDiscountExternalIdMapping[];
};

export type CustomInvoicingDraftSynchronizedRequest = {
  invoicing?: CustomInvoicingSyncResult;
};

export type CustomInvoicingFinalizedRequest = {
  invoicing?: {
    invoiceNumber?: string;
    sentToCustomerAt?: string;
  };
  payment?: {
    externalId?: string;
  };
};

export type CustomInvoicingUpdatePaymentStatusRequest = {
  trigger: CustomInvoicingPaymentTrigger;
};

function requireOpenMeterApiKey(): string {
  const apiKey = process.env.OPENMETER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENMETER_API_KEY is required for Custom Invoicing API calls");
  }
  return apiKey;
}

/** Resolve request URL for self-hosted (`/api/v1/...`) or Konnect (`/apps/...`). */
export function customInvoicingRequestUrl(invoiceId: string, suffix: string): string {
  const rawBase = getHostedOpenMeterUrl();
  const apiKey = process.env.OPENMETER_API_KEY?.trim();
  const useKonnect = isKonnectMeteringUrl(rawBase, apiKey);
  const sdkPath = `/api/v1/apps/custom-invoicing/${encodeURIComponent(invoiceId)}/${suffix}`;
  if (useKonnect) {
    const base = normalizeKonnectMeteringUrl(rawBase);
    const path = rewriteKonnectPathname(sdkPath, "POST");
    return `${base}${path}`;
  }
  return `${rawBase.replace(/\/$/, "")}${sdkPath}`;
}

async function customInvoicingPost(
  invoiceId: string,
  suffix: string,
  body: unknown,
): Promise<void> {
  const apiKey = requireOpenMeterApiKey();
  const url = customInvoicingRequestUrl(invoiceId, suffix);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Custom Invoicing POST ${suffix} for ${invoiceId} failed (${response.status}): ${text}`,
    );
  }
}

/** Submit draft sync results (resume after draft.syncing). */
export async function submitDraftSynchronized(
  invoiceId: string,
  body: CustomInvoicingDraftSynchronizedRequest = {},
): Promise<void> {
  await customInvoicingPost(invoiceId, "draft/synchronized", body);
}

/** Submit issuing sync results (resume after issuing.syncing). */
export async function submitIssuingSynchronized(
  invoiceId: string,
  body: CustomInvoicingFinalizedRequest = {},
): Promise<void> {
  await customInvoicingPost(invoiceId, "issuing/synchronized", body);
}

/** Report payment outcome (mandatory at payment_processing.pending). */
export async function updateCustomInvoicingPaymentStatus(
  invoiceId: string,
  body: CustomInvoicingUpdatePaymentStatusRequest,
): Promise<void> {
  await customInvoicingPost(invoiceId, "payment/status", body);
}

export function resolveCustomInvoicingAppId(): string | null {
  return process.env.OPENMETER_CUSTOM_INVOICING_APP_ID?.trim() || null;
}

export function resolveMerchantBillingProfileId(): string | null {
  return process.env.OPENMETER_MERCHANT_BILLING_PROFILE_ID?.trim() || null;
}

export function requireOpenMeterWebhookSecret(): string {
  const secret = process.env.OPENMETER_WEBHOOK_SECRET?.trim();
  if (!secret) {
    throw new Error(
      "OPENMETER_WEBHOOK_SECRET is required (shared secret configured on the Konnect notification channel)",
    );
  }
  return secret;
}
