/**
 * Fire-and-forget mid-cycle invoice trigger.
 *
 * When soft-negative overage is allowing spend past prepaid $0, promote OpenMeter
 * gathering lines into a real invoice so settlement (merchant Custom Invoicing /
 * Connect) or the OM Stripe app (owner) can collect. pymthouse never creates
 * Stripe PaymentIntents here.
 */
import { createAsyncTtlCache, resolveCacheTtlSeconds } from "@/lib/async-ttl-cache";
import {
  DEFAULT_INVOICE_TRIGGER_LEAD_USD_MICROS,
  effectiveSoftNegativeUsdMicros,
  isInInvoiceTriggerLeadWindow,
} from "@/lib/billing/auto-topup-settings";
import {
  getUnbilledDebtUsdMicros,
  resolveBillingCustomerId,
} from "@/lib/billing/unbilled-debt";
import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "@/lib/openmeter/admin-client";
import { getAppBillingConfig } from "@/lib/openmeter/billing-profiles";
import { resolveOpenMeterBillingIdentity } from "@/lib/openmeter/billing-identity";
import { getProviderApp } from "@/lib/provider-apps";
import { sanitizeForLog } from "@/lib/sanitize-for-log";

const INVOICE_TRIGGER_TTL_SECONDS = resolveCacheTtlSeconds(
  "INVOICE_TRIGGER_COOLDOWN_SECONDS",
  60,
);

let attemptCache: ReturnType<typeof createAsyncTtlCache<boolean>> | null = null;

function getAttemptCache() {
  attemptCache ??= createAsyncTtlCache<boolean>({
    ttlSeconds: INVOICE_TRIGGER_TTL_SECONDS,
    maxEntries: 2000,
  });
  return attemptCache;
}

export function __resetInvoiceTriggerCacheForTests(): void {
  attemptCache = null;
}

function shouldTriggerInvoice(input: {
  unbilledDebtUsdMicros: bigint;
  softNegativeUsdMicros: bigint;
}): boolean {
  if (input.unbilledDebtUsdMicros <= 0n) {
    return false;
  }
  // No debt ceiling configured → mid-cycle invoice any positive gathering debt.
  if (input.softNegativeUsdMicros <= 0n) {
    return true;
  }
  return isInInvoiceTriggerLeadWindow({
    unbilledDebtUsdMicros: input.unbilledDebtUsdMicros,
    softNegativeUsdMicros: input.softNegativeUsdMicros,
    leadUsdMicros: DEFAULT_INVOICE_TRIGGER_LEAD_USD_MICROS,
  });
}

/**
 * Create invoices from gathering lines and advance each toward collection.
 * Returns how many invoices were created (0 if skipped / empty).
 */
export async function maybeInvoiceGatheringForIdentity(input: {
  clientId: string;
  externalUserId: string;
}): Promise<"invoiced" | "skipped" | "rate_limited" | "unavailable" | "error"> {
  const clientId = input.clientId.trim();
  const externalUserId = input.externalUserId.trim();
  if (!clientId || !externalUserId) {
    return "skipped";
  }
  if (!isHostedAdminClientAvailable()) {
    return "unavailable";
  }

  const rateKey = `${clientId}\u0000${externalUserId}`;
  const cache = getAttemptCache();
  const marker = { attempted: false };
  await cache.get(rateKey, async () => {
    marker.attempted = true;
    return true;
  });
  if (!marker.attempted) {
    return "rate_limited";
  }

  try {
    const identity = await resolveOpenMeterBillingIdentity({
      clientId,
      externalUserId,
    });
    const app = await getProviderApp(clientId);
    const appId = app?.id?.trim() || identity.developerAppId;
    const billingConfig = await getAppBillingConfig(appId);
    const softNegativeUsdMicros = effectiveSoftNegativeUsdMicros(
      billingConfig?.softNegativeUsdMicros,
    );
    const unbilledDebtUsdMicros = await getUnbilledDebtUsdMicros({
      clientId,
      externalUserId,
    });
    if (
      !shouldTriggerInvoice({
        unbilledDebtUsdMicros,
        softNegativeUsdMicros,
      })
    ) {
      return "skipped";
    }

    const customerId = await resolveBillingCustomerId({
      clientId,
      externalUserId,
    });
    if (!customerId) {
      return "skipped";
    }

    const client = getHostedAdminClient();
    const invoices = await client.billing.invoices.invoicePendingLines({
      customerId,
      progressiveBillingOverride: true,
    });
    if (!invoices?.length) {
      return "skipped";
    }

    for (const invoice of invoices) {
      const invoiceId = invoice.id?.trim();
      if (!invoiceId) continue;
      try {
        // With auto_advance + P0D this is often a no-op; Custom Invoicing may
        // pause at draft.sync and settlement drives the rest.
        await client.billing.invoices.advance(invoiceId);
      } catch (err) {
        console.warn(
          "[invoice-trigger] advance skipped",
          sanitizeForLog(invoiceId),
          sanitizeForLog(err instanceof Error ? err.message : String(err)),
        );
      }
    }
    return "invoiced";
  } catch (err) {
    console.warn(
      "[invoice-trigger] unexpected failure",
      sanitizeForLog(err instanceof Error ? err.message : String(err)),
    );
    return "error";
  }
}

/** Fire-and-forget mid-cycle invoice raise (lead window / soft-negative allow). */
export function scheduleInvoiceTrigger(input: {
  clientId: string;
  externalUserId: string;
}): void {
  void maybeInvoiceGatheringForIdentity(input).catch((err) => {
    console.warn(
      "[invoice-trigger] schedule failed",
      sanitizeForLog(err instanceof Error ? err.message : String(err)),
    );
  });
}

/** @internal Exported for unit tests. */
export const __testInvoiceTrigger = {
  shouldTriggerInvoice,
};
