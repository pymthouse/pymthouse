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
  effectiveInvoiceLeadUsdMicros,
  effectiveSoftNegativeUsdMicros,
  isInInvoiceTriggerLeadWindow,
  MIN_INVOICE_USD_MICROS,
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
  leadUsdMicros: bigint;
}): boolean {
  // Below Stripe's minimum charge the invoice cannot be collected, so raising
  // it would only park a draft that no collector can clear. Anything left under
  // the floor is swept up by OM's anchored collection alignment or cycle close.
  if (input.unbilledDebtUsdMicros < MIN_INVOICE_USD_MICROS) {
    return false;
  }
  // No debt ceiling configured → mid-cycle invoice any collectable debt.
  if (input.softNegativeUsdMicros <= 0n) {
    return true;
  }
  return isInInvoiceTriggerLeadWindow({
    unbilledDebtUsdMicros: input.unbilledDebtUsdMicros,
    softNegativeUsdMicros: input.softNegativeUsdMicros,
    leadUsdMicros: input.leadUsdMicros,
  });
}

export type InvoiceTriggerOutcome =
  | "invoiced"
  | "skipped"
  | "rate_limited"
  | "unavailable"
  | "error";

export type InvoiceTriggerResult = {
  outcome: InvoiceTriggerOutcome;
  invoiceIds: string[];
};

/**
 * Create invoices from gathering lines and advance each toward collection.
 *
 * `force` skips the lead-window check for an explicit "collect now" request.
 * The Stripe minimum-charge floor always applies: raising an invoice below it
 * only parks a draft no collector can clear.
 */
export async function invoiceGatheringForIdentity(input: {
  clientId: string;
  externalUserId: string;
  force?: boolean;
}): Promise<InvoiceTriggerResult> {
  const clientId = input.clientId.trim();
  const externalUserId = input.externalUserId.trim();
  if (!clientId || !externalUserId) {
    return { outcome: "skipped", invoiceIds: [] };
  }
  if (!isHostedAdminClientAvailable()) {
    return { outcome: "unavailable", invoiceIds: [] };
  }

  const rateKey = `${clientId}\u0000${externalUserId}`;
  const cache = getAttemptCache();
  const marker = { attempted: false };
  await cache.get(rateKey, async () => {
    marker.attempted = true;
    return true;
  });
  if (!marker.attempted) {
    return { outcome: "rate_limited", invoiceIds: [] };
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
    const collectable = unbilledDebtUsdMicros >= MIN_INVOICE_USD_MICROS;
    const shouldRaise = input.force
      ? collectable
      : shouldTriggerInvoice({
          unbilledDebtUsdMicros,
          softNegativeUsdMicros,
          leadUsdMicros: effectiveInvoiceLeadUsdMicros({
            storedUsdMicros: billingConfig?.invoiceLeadUsdMicros,
            softNegativeUsdMicros,
          }),
        });
    if (!shouldRaise) {
      return { outcome: "skipped", invoiceIds: [] };
    }

    const customerId = await resolveBillingCustomerId({
      clientId,
      externalUserId,
    });
    if (!customerId) {
      return { outcome: "skipped", invoiceIds: [] };
    }

    const client = getHostedAdminClient();
    const invoices = await client.billing.invoices.invoicePendingLines({
      customerId,
      progressiveBillingOverride: true,
    });
    if (!invoices?.length) {
      return { outcome: "skipped", invoiceIds: [] };
    }

    const invoiceIds: string[] = [];
    for (const invoice of invoices) {
      const invoiceId = invoice.id?.trim();
      if (!invoiceId) continue;
      invoiceIds.push(invoiceId);
      await advanceInvoice(client, invoiceId, input.force === true);
    }
    return { outcome: "invoiced", invoiceIds };
  } catch (err) {
    console.warn(
      "[invoice-trigger] unexpected failure",
      sanitizeForLog(err instanceof Error ? err.message : String(err)),
    );
    return { outcome: "error", invoiceIds: [] };
  }
}

/**
 * Push a freshly raised invoice toward collection. With auto_advance + P0D
 * `advance` is often a no-op; Custom Invoicing may pause at draft.sync and
 * settlement drives the rest.
 */
async function advanceInvoice(
  client: ReturnType<typeof getHostedAdminClient>,
  invoiceId: string,
  force: boolean,
): Promise<void> {
  if (force) {
    try {
      // Native way to skip the collection period for an invoice parked in
      // draft.waiting_for_collection.
      await client.billing.invoices.snapshotQuantities(invoiceId);
    } catch {
      // Not in a snapshot-able state; advance below still applies.
    }
  }
  try {
    await client.billing.invoices.advance(invoiceId);
  } catch (err) {
    console.warn(
      "[invoice-trigger] advance skipped",
      sanitizeForLog(invoiceId),
      sanitizeForLog(err instanceof Error ? err.message : String(err)),
    );
  }
}

/** Fire-and-forget mid-cycle invoice raise (lead window / soft-negative allow). */
export function scheduleInvoiceTrigger(input: {
  clientId: string;
  externalUserId: string;
}): void {
  void invoiceGatheringForIdentity(input).catch((err) => {
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
