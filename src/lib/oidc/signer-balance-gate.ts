import type {
  BalanceCheck,
  UsageIdentity,
} from "@pymthouse/clearinghouse-identity-webhook/protocol";
import { createBalanceGate } from "@pymthouse/clearinghouse-identity-webhook/balance-gate";
import { isHostedAdminClientAvailable } from "@/lib/openmeter/admin-client";
import { getSpendableUsdMicros } from "@/lib/openmeter/spendable-allowance";

const DEFAULT_REAUTH_TTL_SECONDS = 60;
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

function resolveReauthTtlSeconds(): number {
  const ttl = resolvePositiveSecondsEnv(
    "SIGNER_BALANCE_REAUTH_TTL_SECONDS",
    DEFAULT_REAUTH_TTL_SECONDS,
  );
  return ttl > 0 ? ttl : DEFAULT_REAUTH_TTL_SECONDS;
}

type BalanceCacheEntry = {
  expiresAtMs: number;
  value?: string | null;
  inflight?: Promise<string | null>;
};

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
}): (identity: UsageIdentity) => Promise<string | null> {
  const { ttlSeconds, getBalance } = options;
  const now = options.now ?? Date.now;

  if (ttlSeconds <= 0) {
    return getBalance;
  }

  const entries = new Map<string, BalanceCacheEntry>();

  function evictIfFull(): void {
    if (entries.size < BALANCE_CACHE_MAX_ENTRIES) {
      return;
    }
    for (const [key, entry] of entries) {
      if (entries.size < BALANCE_CACHE_MAX_ENTRIES) {
        break;
      }
      if (!entry.inflight) {
        entries.delete(key);
      }
    }
  }

  return (identity) => {
    const key = `${identity.client_id}\u0000${identity.usage_subject}`;
    const existing = entries.get(key);
    if (existing) {
      if (existing.inflight) {
        return existing.inflight;
      }
      if (existing.expiresAtMs > now()) {
        return Promise.resolve(existing.value ?? null);
      }
      entries.delete(key);
    }

    const inflight = getBalance(identity).then(
      (value) => {
        entries.set(key, { expiresAtMs: now() + ttlSeconds * 1000, value });
        return value;
      },
      (err) => {
        entries.delete(key);
        throw err;
      },
    );

    evictIfFull();
    entries.set(key, { expiresAtMs: now() + ttlSeconds * 1000, inflight });
    return inflight;
  };
}

/**
 * Spendable allowance for a verified signer identity: prepaid credits plus any
 * remaining plan usage discount for the current cycle.
 */
async function readIdentityBalanceUsdMicros(
  identity: UsageIdentity,
): Promise<string | null> {
  return getSpendableUsdMicros({
    clientId: identity.client_id,
    externalUserId: identity.usage_subject,
  });
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
  const cachedBalance = createSpendableBalanceCache({
    ttlSeconds: resolvePositiveSecondsEnv(
      "SIGNER_BALANCE_CACHE_TTL_SECONDS",
      DEFAULT_BALANCE_CACHE_TTL_SECONDS,
    ),
    getBalance: readIdentityBalanceUsdMicros,
  });
  return createBalanceGate({
    getBalanceUsdMicros: (identity) => cachedBalance(identity),
    reauthTtlSeconds: resolveReauthTtlSeconds(),
    failClosed: true,
    onError: (err) => {
      console.warn(
        "[remote-signer] live balance check failed:",
        err instanceof Error ? err.message : String(err),
      );
    },
  });
}
