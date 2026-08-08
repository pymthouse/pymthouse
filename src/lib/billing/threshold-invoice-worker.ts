/**
 * SignerSession-driven threshold raise: when a signing identity is overage-
 * eligible and gathering totals meet the effective Pay-Per-Use / app threshold,
 * call OpenMeter `invoicePendingLines` so billing-profile
 * `charge_automatically` can collect asynchronously.
 *
 * Replaces the former full-app cron sweep — only active signers are checked.
 */
import { createAsyncTtlCache, resolveCacheTtlSeconds } from "@/lib/async-ttl-cache";
import { resolveEffectiveInvoiceThresholdUsdMicros } from "@/lib/billing/effective-invoice-threshold";
import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "@/lib/openmeter/admin-client";
import { resolveOpenMeterBillingIdentity } from "@/lib/openmeter/billing-identity";
import {
  ensureOwnerCustomer,
  findOpenMeterCustomerByKey,
  listOwnedPublicClientIds,
} from "@/lib/openmeter/customers";
import { buildOpenMeterCustomerKey } from "@/lib/openmeter/customer-key";
import { decimalDollarsToUsdMicros } from "@/lib/openmeter/konnect-credits";
import { resolveOpenMeterMeterClientId } from "@/lib/openmeter/meter-client-id";
import { getProviderApp } from "@/lib/provider-apps";
import { sanitizeForLog } from "@/lib/sanitize-for-log";
import { getAppBillingConfig } from "@/lib/openmeter/billing-profiles";

/** Parse OpenMeter gathering invoice `totals.total` into USD micros. */
export function gatheringTotalUsdMicros(total: unknown): bigint | null {
  if (total == null) return null;
  try {
    if (typeof total === "number" && Number.isFinite(total)) {
      return decimalDollarsToUsdMicros(String(total));
    }
    if (typeof total === "string") {
      const trimmed = total.trim();
      if (!trimmed) return null;
      // Some payloads already look like integer micros; prefer dollars when
      // a decimal point is present or the magnitude is small.
      if (/^-?\d+$/.test(trimmed) && trimmed.length > 8) {
        return BigInt(trimmed);
      }
      return decimalDollarsToUsdMicros(trimmed);
    }
  } catch {
    return null;
  }
  return null;
}

/** True when any gathering total has reached the effective threshold. */
export function gatheringInvoiceMeetsThreshold(
  totals: unknown[],
  thresholdUsdMicros: bigint,
): boolean {
  for (const total of totals) {
    const micros = gatheringTotalUsdMicros(total);
    if (micros != null && micros >= thresholdUsdMicros) {
      return true;
    }
  }
  return false;
}

export type GatheringInvoiceLike = {
  status?: string | null;
  totals?: { total?: unknown } | null;
};

/**
 * Decide whether gathering lines meet the threshold and optionally raise.
 */
export async function evaluateAndRaiseGatheringInvoice(input: {
  customerId: string;
  thresholdUsdMicros: bigint;
  invoices: GatheringInvoiceLike[];
  raise: (customerId: string) => Promise<void>;
}): Promise<"raised" | "skipped_no_gathering" | "skipped_below_threshold"> {
  const gathering = input.invoices.filter(
    (inv) => String(inv.status ?? "").toLowerCase() === "gathering",
  );
  if (gathering.length === 0) {
    return "skipped_no_gathering";
  }
  const due = gatheringInvoiceMeetsThreshold(
    gathering.map((inv) => inv.totals?.total),
    input.thresholdUsdMicros,
  );
  if (!due) {
    return "skipped_below_threshold";
  }
  await input.raise(input.customerId);
  return "raised";
}

const DEFAULT_RAISE_RATE_LIMIT_SECONDS = 60;

let raiseAttemptCache: ReturnType<typeof createAsyncTtlCache<true>> | null =
  null;

function getRaiseAttemptCache() {
  raiseAttemptCache ??= createAsyncTtlCache<true>({
    ttlSeconds: resolveCacheTtlSeconds(
      "THRESHOLD_INVOICE_RAISE_TTL_SECONDS",
      DEFAULT_RAISE_RATE_LIMIT_SECONDS,
    ),
  });
  return raiseAttemptCache;
}

/** Test-only: clear the opportunistic-raise rate-limit cache. */
export function __resetThresholdRaiseCacheForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__resetThresholdRaiseCacheForTests is only available in test");
  }
  raiseAttemptCache = null;
}

async function resolveOpenMeterCustomerIdForRaise(input: {
  clientId: string;
  externalUserId: string;
}): Promise<{
  customerId: string;
  appId: string;
  thresholdExternalUserId: string | null;
} | null> {
  const identity = await resolveOpenMeterBillingIdentity({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });
  const client = getHostedAdminClient();

  if (identity.isOwner && identity.ownerUserId) {
    const publicClientIds = await listOwnedPublicClientIds(identity.ownerUserId);
    const ownerCustomer = await ensureOwnerCustomer(
      client,
      identity.ownerUserId,
      publicClientIds,
    );
    const customerId = ownerCustomer.id?.trim();
    if (!customerId) return null;
    return {
      customerId,
      appId: identity.developerAppId,
      thresholdExternalUserId: null,
    };
  }

  const app =
    (await getProviderApp(identity.developerAppId)) ??
    (await getProviderApp(identity.publicClientId)) ??
    (await getProviderApp(input.clientId.trim()));
  const appId = app?.id?.trim() || identity.developerAppId;
  const billingConfig = await getAppBillingConfig(appId);
  const billingMode = billingConfig?.billingMode ?? "owner_rollup";

  if (billingMode === "merchant") {
    const publicClientId = await resolveOpenMeterMeterClientId(appId);
    const key = buildOpenMeterCustomerKey(publicClientId, input.externalUserId.trim());
    const customer = await findOpenMeterCustomerByKey(client, key);
    const customerId = customer?.id?.trim();
    if (!customerId) return null;
    return {
      customerId,
      appId,
      thresholdExternalUserId: input.externalUserId.trim(),
    };
  }

  // owner_rollup end-user: cost rail is the owner shared wallet.
  const ownerId = app?.ownerId?.trim();
  if (!ownerId) return null;
  const publicClientIds = await listOwnedPublicClientIds(ownerId);
  const ownerCustomer = await ensureOwnerCustomer(client, ownerId, publicClientIds);
  const customerId = ownerCustomer.id?.trim();
  if (!customerId) return null;
  return {
    customerId,
    appId,
    thresholdExternalUserId: null,
  };
}

/**
 * Best-effort threshold raise for one SignerSession identity. Never throws —
 * callers must not block mint/authorize on collection.
 */
export async function maybeRaiseThresholdInvoiceForIdentity(input: {
  clientId: string;
  externalUserId: string;
}): Promise<"raised" | "skipped" | "rate_limited" | "unavailable" | "error"> {
  if (!isHostedAdminClientAvailable()) {
    return "unavailable";
  }
  const clientId = input.clientId.trim();
  const externalUserId = input.externalUserId.trim();
  if (!clientId || !externalUserId) {
    return "skipped";
  }

  const rateKey = `${clientId}\u0000${externalUserId}`;
  const cache = getRaiseAttemptCache();
  const marker = { attempted: false };
  await cache.get(rateKey, async () => {
    marker.attempted = true;
    return true;
  });
  if (!marker.attempted) {
    return "rate_limited";
  }

  try {
    const resolved = await resolveOpenMeterCustomerIdForRaise({
      clientId,
      externalUserId,
    });
    if (!resolved) {
      return "skipped";
    }

    const threshold = await resolveEffectiveInvoiceThresholdUsdMicros({
      appId: resolved.appId,
      externalUserId: resolved.thresholdExternalUserId,
    });
    if (threshold == null) {
      return "skipped";
    }

    const client = getHostedAdminClient();
    const listed = await client.billing.invoices.list({
      customers: [resolved.customerId],
      page: 1,
      pageSize: 20,
      order: "DESC",
      orderBy: "createdAt",
    });
    const outcome = await evaluateAndRaiseGatheringInvoice({
      customerId: resolved.customerId,
      thresholdUsdMicros: threshold,
      invoices: listed?.items ?? [],
      raise: async (customerId) => {
        await client.billing.invoices.invoicePendingLines({ customerId });
      },
    });
    return outcome === "raised" ? "raised" : "skipped";
  } catch (err) {
    console.warn(
      "threshold-invoice: opportunistic raise failed",
      sanitizeForLog(clientId),
      sanitizeForLog(externalUserId),
      sanitizeForLog(err),
    );
    return "error";
  }
}

/**
 * Fire-and-forget wrapper for mint / balance webhook. Never awaits settlement.
 */
export function scheduleThresholdInvoiceRaise(input: {
  clientId: string;
  externalUserId: string;
}): void {
  void maybeRaiseThresholdInvoiceForIdentity(input).catch((err) => {
    console.warn(
      "threshold-invoice: schedule failed",
      sanitizeForLog(err),
    );
  });
}
