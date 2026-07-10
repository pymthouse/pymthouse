const TURNKEY_WEBHOOK_JWKS_URL =
  "https://api.turnkey.com/public/v1/discovery/webhooks/jwks";

export type TurnkeyWebhookVerificationKey = {
  keyId: string;
  publicKey: string;
  algorithm: "ed25519";
};

type JwksCache = {
  keys: TurnkeyWebhookVerificationKey[];
  fetchedAtMs: number;
  cacheControlMaxAgeSec: number | null;
};

let jwksCache: JwksCache | null = null;

function parseCacheControlMaxAge(cacheControl: string | null): number | null {
  if (!cacheControl) return null;
  const match = /max-age=(\d+)/i.exec(cacheControl);
  if (!match?.[1]) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapJwksKeys(
  keys: Array<{ kid?: string; x?: string }>,
): TurnkeyWebhookVerificationKey[] {
  const mapped: TurnkeyWebhookVerificationKey[] = [];
  for (const key of keys) {
    if (!key.kid || !key.x) continue;
    mapped.push({
      keyId: key.kid,
      publicKey: Buffer.from(key.x, "base64url").toString("hex"),
      algorithm: "ed25519",
    });
  }
  return mapped;
}

async function fetchJwksFromTurnkey(): Promise<JwksCache> {
  const res = await fetch(TURNKEY_WEBHOOK_JWKS_URL, {
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Turnkey webhook JWKS fetch failed: ${res.status}`);
  }
  const body = (await res.json()) as { keys?: Array<{ kid?: string; x?: string }> };
  const keys = mapJwksKeys(body.keys ?? []);
  if (keys.length === 0) {
    throw new Error("Turnkey webhook JWKS returned no usable keys");
  }
  return {
    keys,
    fetchedAtMs: Date.now(),
    cacheControlMaxAgeSec: parseCacheControlMaxAge(res.headers.get("cache-control")),
  };
}

function isJwksCacheFresh(cache: JwksCache): boolean {
  if (!cache.cacheControlMaxAgeSec) {
    return Date.now() - cache.fetchedAtMs < 5 * 60 * 1000;
  }
  return Date.now() - cache.fetchedAtMs < cache.cacheControlMaxAgeSec * 1000;
}

export async function getTurnkeyWebhookVerificationKeys(): Promise<
  TurnkeyWebhookVerificationKey[]
> {
  if (jwksCache && isJwksCacheFresh(jwksCache)) {
    return jwksCache.keys;
  }
  jwksCache = await fetchJwksFromTurnkey();
  return jwksCache.keys;
}

export async function getTurnkeyWebhookVerificationKeysForKeyId(
  keyId: string,
): Promise<TurnkeyWebhookVerificationKey[]> {
  const cached = jwksCache?.keys.find((key) => key.keyId === keyId);
  if (cached) {
    return jwksCache?.keys ?? [cached];
  }
  jwksCache = await fetchJwksFromTurnkey();
  return jwksCache.keys;
}
