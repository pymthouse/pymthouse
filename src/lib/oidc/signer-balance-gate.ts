import type {
  BalanceCheck,
  UsageIdentity,
} from "@pymthouse/clearinghouse-identity-webhook/protocol";
import { createBalanceGate } from "@pymthouse/clearinghouse-identity-webhook/balance-gate";
import { createAsyncTtlCache } from "@/lib/async-ttl-cache";
import { isHostedAdminClientAvailable } from "@/lib/openmeter/admin-client";
import { getSpendableUsdMicros } from "@/lib/openmeter/spendable-allowance";

const DEFAULT_EXPIRY_TTL_SECONDS = 60;
const DEFAULT_BALANCE_CACHE_TTL_SECONDS = 20;
const BALANCE_CACHE_MAX_ENTRIES = 1000;

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

/** Seed the webhook balance cache after mint so the same request skips a re-fetch. */
export function seedSignerSpendableBalance(
  clientId: string,
  usageSubject: string,
  value: string,
): void {
  getSharedSpendableCache().seed(clientId, usageSubject, value);
}

/**
 * Build the live balance gate for the remote-signer webhook. Returns undefined
 * when hosted billing is not configured, so self-hosted / metering-off
 * deployments authorize on identity alone (matching the mint gate's behavior).
 */
export function buildSignerBalanceCheck(): BalanceCheck | undefined {
  if (!isHostedAdminClientAvailable()) {
    return undefined;
  }
  const cache = getSharedSpendableCache();
  return createBalanceGate({
    getBalanceUsdMicros: (identity) => cache.get(identity),
    expiryTtl: { seconds: resolveExpiryTtlSeconds() },
    failClosed: true,
    onError: (err, identity) => {
      // Name the identity: the client only ever sees a bare 503, so this line
      // is the sole record of which customer's lookup failed.
      console.warn(
        `[remote-signer] live balance check failed client_id=${identity?.client_id} subject=${identity?.usage_subject}:`,
        err instanceof Error ? err.message : String(err),
      );
    },
  });
}
