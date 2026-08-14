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
} from "@/lib/billing/overage-limits";
import { requestSettlementCollect } from "@/lib/billing/settlement-collect-client";
import {
  getUnbilledDebtUsdMicros,
  resolveBillingCustomerId,
} from "@/lib/billing/unbilled-debt";
import { isHostedAdminClientAvailable } from "@/lib/openmeter/admin-client";
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
  // it would only park a draft. OM's daily collection alignment picks these up instead.
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

/**
 * Whether to ask settlement to raise a customer's pending lines.
 * Force collect always attempts; automatic mid-cycle uses debt + lead window.
 */
function shouldAttemptPendingLines(input: {
  force: boolean;
  unbilledDebtUsdMicros: bigint;
  softNegativeUsdMicros: bigint;
  leadUsdMicros: bigint;
}): boolean {
  if (input.force) {
    return true;
  }
  return shouldTriggerInvoice(input);
}

export type InvoiceTriggerOutcome =
  | "queued"
  | "skipped"
  | "rate_limited"
  | "unavailable"
  | "error";

export type InvoiceTriggerResult = {
  outcome: InvoiceTriggerOutcome;
  /**
   * Always empty. Settlement raises the invoice asynchronously off its own
   * Kafka lane, so pymthouse never learns the resulting invoice id
   * synchronously here — read it back from billing history / billing state
   * instead. Kept as a field so existing callers that destructure it need no
   * further change if a future round-trip repopulates it.
   */
  invoiceIds: string[];
};

/**
 * Ask settlement to raise a customer's pending gathering lines into a real
 * invoice.
 *
 * `force` (test-usage / explicit collect-now) always asks — it must not gate
 * on {@link getUnbilledDebtUsdMicros}, which can read $0 when Konnect's
 * invoice list misses gathering totals. Non-force mid-cycle triggers keep the
 * lead-window and Stripe minimum-charge floors via {@link shouldTriggerInvoice}.
 *
 * The raise itself happens in settlement, not here: settlement's per-customer
 * Kafka lane already serializes every event for one customer, so a second
 * raise request for a customer already mid-raise waits its turn there instead
 * of reaching Konnect at the same time and racing the first one into "an
 * active realization run already exists" — the collision this function used
 * to hit directly back when it called OpenMeter itself. This also gets the
 * raise off pymthouse's request path: `"queued"` means settlement accepted
 * the request onto its lane, not that an invoice exists yet.
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

  const rateKey = `${clientId} ${externalUserId}`;
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
    const force = input.force === true;
    if (!force) {
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
      const shouldRaise = shouldAttemptPendingLines({
        force: false,
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
    }

    const customerId = await resolveBillingCustomerId({
      clientId,
      externalUserId,
    });
    if (!customerId) {
      return { outcome: "skipped", invoiceIds: [] };
    }

    const settlementOutcome = await requestSettlementCollect({
      clientId,
      externalUserId,
      customerId,
      force,
    });
    if (settlementOutcome === "unavailable") {
      return { outcome: "unavailable", invoiceIds: [] };
    }
    if (settlementOutcome === "error") {
      return { outcome: "error", invoiceIds: [] };
    }
    return { outcome: "queued", invoiceIds: [] };
  } catch (err) {
    console.warn(
      "[invoice-trigger] unexpected failure",
      sanitizeForLog(err instanceof Error ? err.message : String(err)),
    );
    return { outcome: "error", invoiceIds: [] };
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
  shouldAttemptPendingLines,
};
