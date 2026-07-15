import * as jose from "jose";

const DEFAULT_TTL_MS = 5 * 60 * 1000;
/** Floor between forced refreshes on unknown `kid`, so bad tokens cannot hammer the DB. */
const MIN_REFRESH_INTERVAL_MS = 10 * 1000;

export type LocalJwksResolverOptions = {
  /** JWKS loader; defaults to the DB-backed {@link import("./jwks").getPublicJWKS}. */
  loadJwks?: () => Promise<jose.JSONWebKeySet>;
  /** How long a loaded keyset is reused before reloading. */
  ttlMs?: number;
  /** Clock override for tests. */
  now?: () => number;
};

async function loadPublicJwksFromDb(): Promise<jose.JSONWebKeySet> {
  const { getPublicJWKS } = await import("@/lib/oidc/jwks");
  return getPublicJWKS();
}

/**
 * jose key resolver backed by this deployment's own signing keys (DB), so the
 * remote-signer webhook never performs OIDC discovery / JWKS HTTP requests
 * against itself. The keyset is cached per process and refreshed when it
 * expires or when a token references an unknown `kid` (key rotation).
 */
export function createLocalSignerJwksResolver(
  options: LocalJwksResolverOptions = {},
): jose.JWTVerifyGetKey {
  const loadJwks = options.loadJwks ?? loadPublicJwksFromDb;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;

  let keyset: jose.JWTVerifyGetKey | null = null;
  let loadedAtMs = 0;
  let inflight: Promise<jose.JWTVerifyGetKey> | null = null;

  async function refresh(): Promise<jose.JWTVerifyGetKey> {
    inflight ??= loadJwks()
      .then((jwks) => {
        keyset = jose.createLocalJWKSet(jwks);
        loadedAtMs = now();
        return keyset;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  async function currentKeyset(): Promise<jose.JWTVerifyGetKey> {
    if (keyset && now() - loadedAtMs < ttlMs) {
      return keyset;
    }
    return refresh();
  }

  return async (protectedHeader, token) => {
    const resolver = await currentKeyset();
    try {
      return await resolver(protectedHeader, token);
    } catch (err) {
      const staleForMs = now() - loadedAtMs;
      if (
        err instanceof jose.errors.JWKSNoMatchingKey &&
        staleForMs >= MIN_REFRESH_INTERVAL_MS
      ) {
        const refreshed = await refresh();
        return refreshed(protectedHeader, token);
      }
      throw err;
    }
  };
}
