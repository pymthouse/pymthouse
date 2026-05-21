/**
 * node-oidc-provider configuration.
 *
 * Replaces the 7 custom OIDC route files with a single certified provider.
 */

import { Provider, interactionPolicy } from "oidc-provider";
import type { Configuration, ClientMetadata, KoaContextWithOIDC } from "oidc-provider";
import { PostgresOidcAdapter } from "./adapter";
import { findAccount } from "./account";
import { getIssuer } from "./issuer-urls";
import { hashClientSecret } from "./clients";
import { getTrustedLoginHosts, normalizeDomain } from "./custom-domains";
import { ensureSigningKey } from "./jwks";
import { initiateLoginUriAcceptedByOidcProvider } from "./third-party-initiate-login";
import { db } from "@/db/index";
import { oidcSigningKeys, oidcClients, appAllowedDomains, developerApps } from "@/db/schema";
import { desc, eq, or } from "drizzle-orm";
import { timingSafeEqual } from "crypto";
import * as jose from "jose";

const KEY_ALGORITHM = "RS256";

/**
 * Load JWKS from the `oidc_signing_keys` table.
 *
 * Ensures at least one active signing key exists so node-oidc-provider can
 * populate `idTokenSigningAlgValues` from the keystore. An empty JWKS leaves
 * that list empty and every client fails validation with
 * `id_token_signed_response_alg must not be provided (no values are allowed)`.
 */
async function loadJWKS(): Promise<{ keys: jose.JWK[] }> {
  await ensureSigningKey();

  const keys = await db
    .select()
    .from(oidcSigningKeys)
    .orderBy(desc(oidcSigningKeys.createdAt))
    .limit(5);

  const jwks: jose.JWK[] = [];

  for (const key of keys) {
    const privateKey = await jose.importPKCS8(key.privateKeyPem, KEY_ALGORITHM, {
      extractable: true,
    });
    const jwk = await jose.exportJWK(privateKey);
    jwks.push({
      ...jwk,
      kid: key.kid,
      alg: KEY_ALGORITHM,
      use: "sig",
    });
  }

  return { keys: jwks };
}

/**
 * Load clients from the `oidc_clients` table and convert to the
 * node-oidc-provider ClientMetadata format.
 */
async function loadClients(): Promise<ClientMetadata[]> {
  const rows = await db.select().from(oidcClients);

  return rows.map((row) => {
    const redirectUris = (JSON.parse(row.redirectUris) as string[])
      // Expand wildcard patterns into common localhost ports.
      // node-oidc-provider requires exact redirect URI matching per spec.
      .flatMap((uri) => {
        if (!uri.includes("*")) return [uri];
        // Expand localhost:* to common dev ports
        const expanded: string[] = [];
        const commonPorts = [
          "3000", "3001", "3002", "3003", "3004", "3005",
          "4000", "4001", "4200", "5000", "5173", "5174",
          "8000", "8080", "8081", "8888", "9000",
        ];
        for (const port of commonPorts) {
          expanded.push(uri.replace(/:\*/, `:${port}`).replace(/\*/g, ""));
        }
        return expanded;
      });

    const grantTypes = row.grantTypes.split(",").filter(Boolean);

    // node-oidc-provider requires at least one redirect_uri for all clients.
    // For device-flow-only clients that may have none configured, use a
    // placeholder so the client can still be registered with the provider.
    const effectiveRedirectUris =
      redirectUris.length > 0
        ? redirectUris
        : [`${getIssuer()}/cb`];

    const meta: ClientMetadata = {
      client_id: row.clientId,
      client_name: row.displayName,
      redirect_uris: effectiveRedirectUris,
      grant_types: grantTypes,
      token_endpoint_auth_method: row.tokenEndpointAuthMethod as "none" | "client_secret_post" | "client_secret_basic",
      scope: row.allowedScopes,
    };
    meta.response_types = grantTypes.includes("authorization_code") ? ["code"] : [];

    if (row.clientSecretHash) {
      meta.client_secret = row.clientSecretHash;
      meta.client_secret_expires_at = 0;
    }

    // White-label client metadata
    if (row.postLogoutRedirectUris) {
      try {
        const parsed = JSON.parse(row.postLogoutRedirectUris) as string[];
        if (parsed.length > 0) meta.post_logout_redirect_uris = parsed;
      } catch { /* malformed JSON, skip */ }
    }
    if (
      row.initiateLoginUri &&
      initiateLoginUriAcceptedByOidcProvider(row.initiateLoginUri)
    ) {
      meta.initiate_login_uri = row.initiateLoginUri;
    }
    if (row.logoUri) meta.logo_uri = row.logoUri;
    if (row.policyUri) meta.policy_uri = row.policyUri;
    if (row.tosUri) meta.tos_uri = row.tosUri;
    if (row.clientUri) meta.client_uri = row.clientUri;

    return meta;
  });
}

function patchHashedClientSecretComparison(provider: Provider): void {
  const clientPrototype = (
    provider.Client as unknown as {
      prototype?: {
        compareClientSecret?: (actual: string) => Promise<boolean> | boolean;
        __pmthHashedSecretPatchApplied?: boolean;
      };
    }
  ).prototype;

  if (!clientPrototype?.compareClientSecret) {
    return;
  }

  if (clientPrototype.__pmthHashedSecretPatchApplied) {
    return;
  }

  const originalCompare = clientPrototype.compareClientSecret;
  clientPrototype.compareClientSecret = async function patchedCompare(actual: string) {
    const storedSecret = (this as { clientSecret?: string }).clientSecret;
    if (typeof storedSecret === "string" && /^[a-f0-9]{64}$/i.test(storedSecret)) {
      const actualHash = hashClientSecret(actual ?? "");
      const stored = Buffer.from(storedSecret);
      const provided = Buffer.from(actualHash);
      if (stored.length !== provided.length) {
        return false;
      }
      return timingSafeEqual(stored, provided);
    }
    return originalCompare.call(this, actual);
  };

  clientPrototype.__pmthHashedSecretPatchApplied = true;
}

/**
 * Build the interaction policy with consent prompts for new scopes.
 */
function buildInteractionPolicy() {
  const basePolicy = interactionPolicy.base();

  const consent = basePolicy.find((p) => p.name === "consent");
  if (consent) {
    const { Check } = interactionPolicy;
    consent.checks.clear();
    consent.checks.add(
      new Check(
        "native_client_prompt",
        "consent required for third-party clients",
        async (ctx) => {
          const oidc = ctx.oidc;
          const requestedScopes = Array.from(oidc.requestParamScopes ?? []);
          const grantId = oidc.session?.grantIdFor(oidc.client!.clientId);
          if (!grantId) {
            return Check.REQUEST_PROMPT;
          }

          const grant = await ctx.oidc.provider.Grant.find(grantId);
          if (!grant) {
            return Check.REQUEST_PROMPT;
          }

          const grantedScopeSet = new Set(
            (grant
              .getOIDCScope()
              .split(/\s+/)
              .map((scope) => scope.trim())
              .filter(Boolean)),
          );

          const allRequestedScopesCovered = requestedScopes.every((scope) =>
            grantedScopeSet.has(scope),
          );

          return allRequestedScopesCovered
            ? Check.NO_NEED_TO_PROMPT
            : Check.REQUEST_PROMPT;
        },
        (ctx) => ({ scopes: ctx.oidc.requestParamScopes }),
      ),
    );
  }

  return basePolicy;
}

let _provider: Provider | null = null;
let _cleanupInterval: ReturnType<typeof setInterval> | null = null;

// TTL-cached CORS snapshot (refreshes every 60s)
let _corsCache: {
  trustedHosts: string[];
  clientOrigins: Map<string, Set<string>>;
} | null = null;
let _corsCacheExpiry = 0;
const CORS_CACHE_TTL_MS = 60_000;

async function getCorsSnapshot() {
  const now = Date.now();
  if (_corsCache && now < _corsCacheExpiry) return _corsCache;
  _corsCache = await buildCorsSnapshot();
  _corsCacheExpiry = now + CORS_CACHE_TTL_MS;
  return _corsCache;
}

async function buildCorsSnapshot(): Promise<{
  trustedHosts: string[];
  clientOrigins: Map<string, Set<string>>;
}> {
  const trustedHosts = await getTrustedLoginHosts();
  const oidcRows = await db.select().from(oidcClients);
  const clientOrigins = new Map<string, Set<string>>();

  for (const oc of oidcRows) {
    const appRows = await db
      .select({ id: developerApps.id })
      .from(developerApps)
      .where(
        or(
          eq(developerApps.oidcClientId, oc.id),
          eq(developerApps.m2mOidcClientId, oc.id),
        ),
      )
      .limit(1);
    const app = appRows[0];
    if (!app) continue;
    const domains = await db
      .select()
      .from(appAllowedDomains)
      .where(eq(appAllowedDomains.appId, app.id));
    clientOrigins.set(
      oc.clientId,
      new Set(domains.map((d) => d.domain)),
    );
  }

  return { trustedHosts, clientOrigins };
}

export async function getProvider(): Promise<Provider> {
  if (_provider) return _provider;

  const issuer = getIssuer();
  const jwks = await loadJWKS();
  const clients = await loadClients();

  const configuration: Configuration = {
    adapter: PostgresOidcAdapter,

    clients,

    findAccount,

    jwks: jwks as Configuration["jwks"],

    // Allow CORS from redirect URI origins, whitelisted domains, custom login domains, plus the issuer origin.
    clientBasedCORS: (_ctx, origin, client) => {
      const issuerOrigin = new URL(issuer).origin;
      if (origin === issuerOrigin) {
        return true;
      }

      // Use cached snapshot (refreshed in background via TTL)
      const corsSnapshot = _corsCache;

      try {
        const originUrl = new URL(origin);
        const originHost = normalizeDomain(originUrl.host);
        if (
          corsSnapshot?.trustedHosts.some(
            (h) => normalizeDomain(h) === originHost,
          )
        ) {
          return true;
        }
      } catch {
        /* invalid origin */
      }

      const uris = client.redirectUris ?? [];
      const matchesRedirectUri = uris.some((uri) => {
        try {
          return new URL(uri).origin === origin;
        } catch {
          return false;
        }
      });
      if (matchesRedirectUri) return true;

      const allowed = corsSnapshot?.clientOrigins.get(client.clientId);
      if (allowed?.has(origin)) return true;

      // Trigger async refresh so next request picks up changes
      void getCorsSnapshot();

      return false;
    },

    scopes: [
      "openid",
      "sign:job",
      "users:read",
      "users:write",
      "users:token",
      "device:approve",
      "admin",
    ],

    claims: {
      openid: ["sub"],
      "sign:job": ["sub"],
      "users:read": ["sub"],
      "users:write": ["sub"],
      "users:token": ["sub"],
      "device:approve": ["sub"],
      admin: ["sub"],
    },

    // Only support code flow
    responseTypes: ["code"],

    // Support these auth methods
    clientAuthMethods: ["none", "client_secret_post", "client_secret_basic"],

    // PKCE required for public clients
    pkce: {
      required: (_ctx, client) => client.tokenEndpointAuthMethod === "none",
    },

    // Rotate refresh tokens on use
    rotateRefreshToken: true,

    // Always issue refresh tokens when refresh_token grant is allowed
    issueRefreshToken: async (_ctx, client, code) => {
      if (!client.grantTypeAllowed("refresh_token")) return false;
      return true;
    },

    features: {
      devInteractions: { enabled: false },
      clientCredentials: { enabled: true },
      deviceFlow: {
        enabled: true,
        charset: "base-20",
        mask: "****-****",
        // Redirect the provider's built-in device pages to our custom React UI.
        // Without these overrides, visiting `/api/v1/oidc/device/<code>` renders
        // the provider's default HTML which fails (devInteractions is off).
        userCodeInputSource: async (ctx, _form, _out, _err) => {
          const u = new URL(`${issuer.replace(/\/api\/v1\/oidc$/, "")}/oidc/device`);
          const cid = ctx.oidc?.client?.clientId;
          if (cid) u.searchParams.set("client_id", cid);
          u.searchParams.set("iss", getIssuer());
          ctx.redirect(u.toString());
        },
        userCodeConfirmSource: async (ctx, _form, client, _deviceInfo, userCode) => {
          const u = new URL(`${issuer.replace(/\/api\/v1\/oidc$/, "")}/oidc/device`);
          u.searchParams.set("user_code", userCode);
          const cid = client?.clientId ?? ctx.oidc?.client?.clientId;
          if (cid) u.searchParams.set("client_id", cid);
          u.searchParams.set("iss", getIssuer());
          ctx.redirect(u.toString());
        },
        successSource: async (ctx) => {
          ctx.body = `<!DOCTYPE html><html><head><title>Device Authorized</title></head>`
            + `<body><h1>Device Authorized</h1><p>You can close this window and return to your device.</p></body></html>`;
        },
      },
      rpInitiatedLogout: { enabled: true },
      userinfo: { enabled: true },
      revocation: { enabled: true },
      introspection: { enabled: true },
      resourceIndicators: {
        enabled: true,
        defaultResource: async (_ctx, _client, oneOf) => {
          // RFC 8707 strict mode: require an explicit resource parameter.
          // When the grant already has a single resource bound, allow it through;
          // otherwise return the issuer so the provider can validate it.
          if (typeof oneOf === "string") return oneOf;
          if (Array.isArray(oneOf) && oneOf.length === 1) return oneOf[0];
          return issuer;
        },
        getResourceServerInfo: async (_ctx, resourceIndicator, _client) => {
          if (resourceIndicator !== issuer) {
            throw new Error(`Unknown resource indicator: ${resourceIndicator}`);
          }
          return {
            scope: "openid sign:job users:read users:write users:token device:approve admin",
            audience: issuer,
            accessTokenFormat: "jwt" as const,
            accessTokenTTL: 3600,
            jwt: {
              sign: { alg: "RS256" as const },
            },
          };
        },
        useGrantedResource: async () => true,
      },
    },

    // TTLs matching the current implementation
    ttl: {
      AccessToken: 3600,          // 1 hour
      AuthorizationCode: 600,     // 10 minutes
      DeviceCode: 600,            // 10 minutes
      IdToken: 3600,              // 1 hour
      RefreshToken: 30 * 24 * 3600, // 30 days
      Interaction: 600,           // 10 minutes
      Session: 14 * 24 * 3600,   // 14 days
      Grant: 14 * 24 * 3600,     // 14 days
    },

    // Interaction URL — redirect to our custom consent/login pages
    interactions: {
      policy: buildInteractionPolicy(),
      url: async (ctx: KoaContextWithOIDC, interaction) => {
        // Always route through a single interaction page so login and consent
        // share one cookie-bound interaction lifecycle.
        return `/oidc/interaction?uid=${interaction.uid}`;
      },
    },

    // Cookie signing keys and path
    cookies: {
      keys: (() => {
        const secret = process.env.NEXTAUTH_SECRET;
        if (!secret && process.env.NODE_ENV === "production") {
          throw new Error(
            "NEXTAUTH_SECRET must be set in production. " +
            "Generate one with: openssl rand -base64 32",
          );
        }
        return [secret ?? "dev-secret-change-me"];
      })(),
      // Use path=/ so _interaction cookie is sent for /oidc/interaction, /api/v1/oidc/interaction,
      // and consent POSTs. The default (path=destination) would restrict the cookie to the
      // interaction URL only, breaking client-side POSTs to the API route.
      short: {
        httpOnly: true,
        sameSite: "lax" as const,
        path: "/",
      },
    },

    // Conformant id_token claims (only include sub by default, rest via userinfo)
    // Set to false to include claims in id_token directly (matching current behavior)
    conformIdTokenClaims: false,

    // RS256 only
    enabledJWA: {
      idTokenSigningAlgValues: ["RS256"],
    },

    // Load existing grants for returning users
    loadExistingGrant: async (ctx) => {
      const grantId =
        ctx.oidc.result?.consent?.grantId ||
        ctx.oidc.session!.grantIdFor(ctx.oidc.client!.clientId);

      if (grantId) {
        const grant = await ctx.oidc.provider.Grant.find(grantId);
        if (grant) return grant;
      }

      return undefined;
    },
  };

  _provider = new Provider(issuer, configuration);
  patchHashedClientSecretComparison(_provider);

  // Trust the proxy (Next.js + reverse proxy)
  _provider.proxy = true;

  // Seed the CORS cache
  await getCorsSnapshot();

  // Run periodic cleanup of expired adapter rows (deduplicated)
  if (_cleanupInterval) clearInterval(_cleanupInterval);
  _cleanupInterval = setInterval(() => {
    PostgresOidcAdapter.cleanup().catch((err) =>
      console.error("Oidc cleanup failed", err),
    );
  }, 10 * 60 * 1000);

  return _provider;
}

/**
 * Reset the cached provider instance, forcing re-initialization on the next
 * call to getProvider(). Call this after updating client metadata (e.g. from
 * the app settings API) so the provider picks up the changes.
 */
export function resetProvider(): void {
  if (_cleanupInterval) {
    clearInterval(_cleanupInterval);
    _cleanupInterval = null;
  }
  _corsCache = null;
  _corsCacheExpiry = 0;
  _provider = null;
}
