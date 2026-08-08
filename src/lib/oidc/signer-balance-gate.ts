import type {
  BalanceCheck,
  UsageIdentity,
} from "@pymthouse/clearinghouse-identity-webhook/protocol";
import {
  REMOTE_SIGNER_ERROR_CODE,
  REMOTE_SIGNER_HTTP_STATUS,
  WebhookError,
} from "@pymthouse/clearinghouse-identity-webhook/protocol";
import { parseUsdMicros } from "@pymthouse/clearinghouse-identity-webhook/balance-gate";
import { createAsyncTtlCache } from "@/lib/async-ttl-cache";
import { resolveAllowsOverageInvoicing } from "@/lib/billing/overage-invoicing";
import { isHostedAdminClientAvailable } from "@/lib/openmeter/admin-client";
import { getSpendableUsdMicros } from "@/lib/openmeter/spendable-allowance";

const DEFAULT_EXPIRY_TTL_SECONDS = 60;
const DEFAULT_BALANCE_CACHE_TTL_SECONDS = 20;
const DEFAULT_OVERAGE_CACHE_TTL_SECONDS = 20;
const BALANCE_CACHE_MAX_ENTRIES = 1000;
const MIN_BALANCE_USD_MICROS = 1n;

function resolvePositiveSecondsEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

/** Whole seconds for the webhook `expiry` cap that forces go-livepeer to reauthorize. */
function resolveExpiryTtlSeconds(): number {
  const ttl = resolvePositiveSecondsEnv(
    "SIGNER_BALANCE_REAUTH_TTL_SECONDS",
    DEFAULT_EXPIRY_TTL_SECONDS,
  );
  return Number.isInteger(ttl) && ttl > 0 ? ttl : DEFAULT_EXPIRY_TTL_SECONDS;
}

export type SpendableBalanceCache = {
  get: (identity: UsageIdentity) => Promise<string | null>;
  seed: (clientId: string, usageSubject: string, value: string) => void;
};

function cacheKey(clientId: string, usageSubject: string): string {
  return `${clientId}\u0000${usageSubject}`;
}

/**
 * Short-lived keyed cache with singleflight for spendable-balance lookups
 * (issue #248). Concurrent webhook calls for the same identity share one
 * OpenMeter/Neon fan-out, and repeat calls within the TTL are served from
 * memory. Failed lookups are never cached, so transient errors retry.
 */
export function createSpendableBalanceCache(options: {
  ttlSeconds: number;
  getBalance: (identity: UsageIdentity) => Promise<string | null>;
  now?: () => number;
  /** Override for tests; production uses {@link BALANCE_CACHE_MAX_ENTRIES}. */
  maxEntries?: number;
}): SpendableBalanceCache {
  const cache = createAsyncTtlCache<string | null>({
    ttlSeconds: options.ttlSeconds,
    maxEntries: options.maxEntries ?? BALANCE_CACHE_MAX_ENTRIES,
    now: options.now,
  });

  return {
    seed(clientId, usageSubject, value) {
      cache.seed(cacheKey(clientId, usageSubject), value);
    },
    get(identity) {
      return cache.get(cacheKey(identity.client_id, identity.usage_subject), () =>
        options.getBalance(identity),
      );
    },
  };
}

/**
 * Spendable allowance for a verified signer identity: prepaid credits plus any
 * remaining plan usage discount for the current cycle. Values are integer
 * micros — {@link getSpendableUsdMicros} already ceils fractional meter sums
 * once at the read boundary (exact ingest, no per-ticket ceil).
 */
async function readIdentityBalanceUsdMicros(
  identity: UsageIdentity,
): Promise<string | null> {
  return getSpendableUsdMicros({
    clientId: identity.client_id,
    externalUserId: identity.usage_subject,
  });
}

/** Process-local cache shared by mint (seed) and the webhook balance gate. */
let sharedSpendableCache: SpendableBalanceCache | null = null;

function getSharedSpendableCache(): SpendableBalanceCache {
  sharedSpendableCache ??= createSpendableBalanceCache({
    ttlSeconds: resolvePositiveSecondsEnv(
      "SIGNER_BALANCE_CACHE_TTL_SECONDS",
      DEFAULT_BALANCE_CACHE_TTL_SECONDS,
    ),
    getBalance: readIdentityBalanceUsdMicros,
  });
  return sharedSpendableCache;
}

let sharedOverageCache: ReturnType<
  typeof createAsyncTtlCache<boolean>
> | null = null;

function getSharedOverageCache() {
  sharedOverageCache ??= createAsyncTtlCache<boolean>({
    ttlSeconds: resolvePositiveSecondsEnv(
      "SIGNER_OVERAGE_CACHE_TTL_SECONDS",
      DEFAULT_OVERAGE_CACHE_TTL_SECONDS,
    ),
    maxEntries: BALANCE_CACHE_MAX_ENTRIES,
  });
  return sharedOverageCache;
}

/** Seed the webhook balance cache after mint so the same request skips a re-fetch. */
export function seedSignerSpendableBalance(
  clientId: string,
  usageSubject: string,
  value: string,
): void {
  getSharedSpendableCache().seed(clientId, usageSubject, value);
}

/** Seed overage eligibility (tests / mint warm-path). */
export function seedSignerOverageEligibility(
  clientId: string,
  usageSubject: string,
  allows: boolean,
): void {
  getSharedOverageCache().seed(cacheKey(clientId, usageSubject), allows);
}

/** Test-only: clear process-local caches between suite runs. */
export function __resetSignerBalanceCachesForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__resetSignerBalanceCachesForTests is only available in test");
  }
  sharedSpendableCache = null;
  sharedOverageCache = null;
}

async function identityAllowsOverage(identity: UsageIdentity): Promise<boolean> {
  return getSharedOverageCache().get(
    cacheKey(identity.client_id, identity.usage_subject),
    () =>
      resolveAllowsOverageInvoicing({
        clientId: identity.client_id,
        externalUserId: identity.usage_subject,
      }),
  );
}

/**
 * Build the live balance gate for the remote-signer webhook. Returns undefined
 * when hosted billing is not configured, so self-hosted / metering-off
 * deployments authorize on identity alone (matching the mint gate's behavior).
 *
 * When spendable is below the minimum, the same mode-aware overage predicate as
 * mint unlocks authorization (owner Paid+PM under rollup; Connect PM under
 * merchant) so mid-stream `/generate-live-payment` does not 483.
 */
export function buildSignerBalanceCheck(): BalanceCheck | undefined {
  if (!isHostedAdminClientAvailable()) {
    return undefined;
  }
  const cache = getSharedSpendableCache();
  const expiryTtlSeconds = resolveExpiryTtlSeconds();

  return async function checkBalance(ctx) {
    let rawBalance: string | null;
    try {
      rawBalance = await cache.get(ctx.identity);
    } catch (err) {
      console.warn(
        `[remote-signer] live balance check failed client_id=${ctx.identity.client_id} subject=${ctx.identity.usage_subject}:`,
        err instanceof Error ? err.message : String(err),
      );
      throw new WebhookError("billing balance lookup failed", {
        status: REMOTE_SIGNER_HTTP_STATUS.BILLING_UNAVAILABLE,
        code: REMOTE_SIGNER_ERROR_CODE.BILLING_UNAVAILABLE,
      });
    }

    const balance = parseUsdMicros(rawBalance);
    if (balance === null) {
      console.warn(
        `[remote-signer] live balance check failed client_id=${ctx.identity.client_id} subject=${ctx.identity.usage_subject}:`,
        `balance is not an integer micros value: ${String(rawBalance)}`,
      );
      throw new WebhookError("billing balance unavailable", {
        status: REMOTE_SIGNER_HTTP_STATUS.BILLING_UNAVAILABLE,
        code: REMOTE_SIGNER_ERROR_CODE.BILLING_UNAVAILABLE,
      });
    }

    if (balance < MIN_BALANCE_USD_MICROS) {
      let allowsOverage = false;
      try {
        allowsOverage = await identityAllowsOverage(ctx.identity);
      } catch (err) {
        console.warn(
          `[remote-signer] overage check failed client_id=${ctx.identity.client_id} subject=${ctx.identity.usage_subject}:`,
          err instanceof Error ? err.message : String(err),
        );
        allowsOverage = false;
      }
      if (!allowsOverage) {
        throw new WebhookError("Payment method required", {
          status: REMOTE_SIGNER_HTTP_STATUS.INSUFFICIENT_BALANCE,
          code: REMOTE_SIGNER_ERROR_CODE.INSUFFICIENT_BALANCE,
        });
      }
    }

    return { expiry: Math.floor(Date.now() / 1000) + expiryTtlSeconds };
  };
}
