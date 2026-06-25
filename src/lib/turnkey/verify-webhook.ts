import {
  verifyTurnkeyWebhookSignature,
  type TurnkeyWebhookVerificationKey,
} from "@turnkey/crypto";

const TURNKEY_WEBHOOK_JWKS_URL =
  process.env.TURNKEY_WEBHOOK_JWKS_URL?.trim() ||
  "https://api.turnkey.com/public/v1/discovery/webhooks/jwks";

const JWKS_CACHE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_TIMESTAMP_AGE_MS = 5 * 60 * 1000;

type JwksCacheEntry = {
  keys: TurnkeyWebhookVerificationKey[];
  fetchedAtMs: number;
};

let jwksCache: JwksCacheEntry | null = null;

function parseEnvVerificationKeys(): TurnkeyWebhookVerificationKey[] {
  const keyId = process.env.TURNKEY_WEBHOOK_KEY_ID?.trim();
  const publicKey = process.env.TURNKEY_WEBHOOK_PUBLIC_KEY?.trim();
  if (!keyId || !publicKey) {
    return [];
  }
  return [{ keyId, publicKey, algorithm: "ed25519" }];
}

async function fetchJwksVerificationKeys(): Promise<TurnkeyWebhookVerificationKey[]> {
  const now = Date.now();
  if (jwksCache && now - jwksCache.fetchedAtMs < JWKS_CACHE_TTL_MS) {
    return jwksCache.keys;
  }

  const res = await fetch(TURNKEY_WEBHOOK_JWKS_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Turnkey webhook JWKS fetch failed: HTTP ${res.status}`);
  }

  const json = (await res.json()) as {
    keys?: Array<{
      keyId?: string;
      publicKey?: string;
      algorithm?: string;
    }>;
  };

  const keys: TurnkeyWebhookVerificationKey[] = (json.keys ?? [])
    .filter((k) => k.keyId && k.publicKey)
    .map((k) => ({
      keyId: k.keyId!,
      publicKey: k.publicKey!,
      algorithm: "ed25519",
    }));

  if (keys.length === 0) {
    throw new Error("Turnkey webhook JWKS returned no verification keys");
  }

  jwksCache = { keys, fetchedAtMs: now };
  return keys;
}

async function resolveVerificationKeys(): Promise<TurnkeyWebhookVerificationKey[]> {
  const envKeys = parseEnvVerificationKeys();
  if (envKeys.length > 0) {
    return envKeys;
  }
  return fetchJwksVerificationKeys();
}

export type VerifiedTurnkeyWebhook = {
  eventId: string;
  keyId: string;
  timestampMs: number;
};

/**
 * Verify a Turnkey webhook request using JWKS (or env override keys).
 * Returns null when verification fails.
 */
export async function verifyTurnkeyWebhookRequest(
  headers: Headers,
  body: string,
  options?: { maxTimestampAgeMs?: number; nowMs?: number },
): Promise<VerifiedTurnkeyWebhook | null> {
  const verificationKeys = await resolveVerificationKeys();
  const result = verifyTurnkeyWebhookSignature({
    headers,
    body,
    verificationKeys,
    maxTimestampAgeMs:
      options?.maxTimestampAgeMs ?? DEFAULT_MAX_TIMESTAMP_AGE_MS,
    nowMs: options?.nowMs,
  });

  if (!result.ok) {
    return null;
  }

  return {
    eventId: result.eventId,
    keyId: result.keyId,
    timestampMs: result.timestampMs,
  };
}

/** Test helper: reset JWKS cache between tests. */
export function resetTurnkeyWebhookJwksCacheForTests(): void {
  jwksCache = null;
}
