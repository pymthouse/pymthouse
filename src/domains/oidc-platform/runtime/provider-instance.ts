/**
 * node-oidc-provider configuration.
 *
 * Replaces the 7 custom OIDC route files with a single certified provider.
 */

import { Provider, interactionPolicy } from "oidc-provider";
import type { Configuration, ClientMetadata, KoaContextWithOIDC } from "oidc-provider";
import { timingSafeEqual } from "crypto";
import * as jose from "jose";
import { PostgresOidcAdapter } from "@/domains/oidc-platform/runtime/adapter";
import { findAccount } from "@/domains/oidc-platform/runtime/account";
import { getIssuer } from "@/platform/oidc/issuer-urls";
import { ensureSigningKey } from "@/domains/oidc-platform/runtime/jwks";
import {
  getTrustedLoginHosts,
  normalizeDomain,
} from "@/domains/oidc-platform/runtime/custom-domains";
import { initiateLoginUriAcceptedByOidcProvider } from "@/platform/oidc/third-party-initiate-login";
import {
  listAllowedDomainsForApp,
  listAllOidcClients,
  listDeveloperAppsForOidcClientRowId,
  listRecentSigningKeys,
} from "../repo/provider-instance";
import { hashClientSecret } from "./clients";

const KEY_ALGORITHM = "RS256";

async function loadJWKS(): Promise<{ keys: jose.JWK[] }> {
  await ensureSigningKey();

  const keys = await listRecentSigningKeys(5);

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

async function loadClients(): Promise<ClientMetadata[]> {
  const rows = await listAllOidcClients();

  return rows.map((row) => {
    const redirectUris = (JSON.parse(row.redirectUris) as string[]).flatMap((uri) => {
      if (!uri.includes("*")) return [uri];
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
    const effectiveRedirectUris =
      redirectUris.length > 0 ? redirectUris : [`${getIssuer()}/cb`];

    const meta: ClientMetadata = {
      client_id: row.clientId,
      client_name: row.displayName,
      redirect_uris: effectiveRedirectUris,
      grant_types: grantTypes,
      token_endpoint_auth_method: row.tokenEndpointAuthMethod as
        | "none"
        | "client_secret_post"
        | "client_secret_basic",
      scope: row.allowedScopes,
    };
    meta.response_types = grantTypes.includes("authorization_code") ? ["code"] : [];

    if (row.clientSecretHash) {
      meta.client_secret = row.clientSecretHash;
      meta.client_secret_expires_at = 0;
    }

    if (row.postLogoutRedirectUris) {
      try {
        const parsed = JSON.parse(row.postLogoutRedirectUris) as string[];
        if (parsed.length > 0) meta.post_logout_redirect_uris = parsed;
      } catch {}
    }
    if (row.initiateLoginUri && initiateLoginUriAcceptedByOidcProvider(row.initiateLoginUri)) {
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

  if (!clientPrototype?.compareClientSecret || clientPrototype.__pmthHashedSecretPatchApplied) {
    return;
  }

  const originalCompare = clientPrototype.compareClientSecret;
  clientPrototype.compareClientSecret = async function patchedCompare(actual: string) {
    const storedSecret = (this as { clientSecret?: string }).clientSecret;
    if (typeof storedSecret === "string" && /^[a-f0-9]{64}$/i.test(storedSecret)) {
      const actualHash = hashClientSecret(actual ?? "");
      const stored = Buffer.from(storedSecret);
      const provided = Buffer.from(actualHash);
      if (stored.length !== provided.length) return false;
      return timingSafeEqual(stored, provided);
    }
    return originalCompare.call(this, actual);
  };

  clientPrototype.__pmthHashedSecretPatchApplied = true;
}

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
          const requestedScopes = Array.from(ctx.oidc.requestParamScopes ?? []);
          const grantId = ctx.oidc.session?.grantIdFor(ctx.oidc.client!.clientId);
          if (!grantId) return Check.REQUEST_PROMPT;
          const grant = await ctx.oidc.provider.Grant.find(grantId);
          if (!grant) return Check.REQUEST_PROMPT;

          const grantedScopeSet = new Set(
            grant
              .getOIDCScope()
              .split(/\s+/)
              .map((scope) => scope.trim())
              .filter(Boolean),
          );
          const covered = requestedScopes.every((scope) => grantedScopeSet.has(scope));
          return covered ? Check.NO_NEED_TO_PROMPT : Check.REQUEST_PROMPT;
        },
        (ctx) => ({ scopes: ctx.oidc.requestParamScopes }),
      ),
    );
  }

  return basePolicy;
}

let providerInstance: Provider | null = null;
let cleanupInterval: ReturnType<typeof setInterval> | null = null;
let corsCache: { trustedHosts: string[]; clientOrigins: Map<string, Set<string>> } | null = null;
let corsCacheExpiry = 0;
const CORS_CACHE_TTL_MS = 60_000;

async function buildCorsSnapshot(): Promise<{
  trustedHosts: string[];
  clientOrigins: Map<string, Set<string>>;
}> {
  const trustedHosts = await getTrustedLoginHosts();
  const oidcRows = await listAllOidcClients();
  const clientOrigins = new Map<string, Set<string>>();

  for (const oc of oidcRows) {
    const appRows = await listDeveloperAppsForOidcClientRowId(oc.id);
    const app = appRows[0];
    if (!app) continue;
    const domains = await listAllowedDomainsForApp(app.id);
    clientOrigins.set(oc.clientId, new Set(domains.map((domain) => domain.domain)));
  }

  return { trustedHosts, clientOrigins };
}

async function getCorsSnapshot() {
  const now = Date.now();
  if (corsCache && now < corsCacheExpiry) return corsCache;
  corsCache = await buildCorsSnapshot();
  corsCacheExpiry = now + CORS_CACHE_TTL_MS;
  return corsCache;
}

export async function getProvider(): Promise<Provider> {
  if (providerInstance) return providerInstance;

  const issuer = getIssuer();
  const jwks = await loadJWKS();
  const clients = await loadClients();

  const configuration: Configuration = {
    adapter: PostgresOidcAdapter,
    clients,
    findAccount,
    jwks: jwks as Configuration["jwks"],
    clientBasedCORS: (_ctx, origin, client) => {
      const issuerOrigin = new URL(issuer).origin;
      if (origin === issuerOrigin) return true;

      const snapshot = corsCache;
      try {
        const originUrl = new URL(origin);
        const originHost = normalizeDomain(originUrl.host);
        if (snapshot?.trustedHosts.some((host) => normalizeDomain(host) === originHost)) {
          return true;
        }
      } catch {}

      const matchesRedirectUri = (client.redirectUris ?? []).some((uri) => {
        try {
          return new URL(uri).origin === origin;
        } catch {
          return false;
        }
      });
      if (matchesRedirectUri) return true;

      const allowed = snapshot?.clientOrigins.get(client.clientId);
      if (allowed?.has(origin)) return true;
      void getCorsSnapshot();
      return false;
    },
    scopes: ["openid", "sign:job", "users:read", "users:write", "users:token", "device:approve", "admin"],
    claims: {
      openid: ["sub"],
      "sign:job": ["sub"],
      "users:read": ["sub"],
      "users:write": ["sub"],
      "users:token": ["sub"],
      "device:approve": ["sub"],
      admin: ["sub"],
    },
    responseTypes: ["code"],
    clientAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
    pkce: { required: (_ctx, client) => client.tokenEndpointAuthMethod === "none" },
    rotateRefreshToken: true,
    issueRefreshToken: async (_ctx, client) => client.grantTypeAllowed("refresh_token"),
    features: {
      devInteractions: { enabled: false },
      clientCredentials: { enabled: true },
      deviceFlow: {
        enabled: true,
        charset: "base-20",
        mask: "****-****",
        userCodeInputSource: async (ctx) => {
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
          ctx.body = "<!DOCTYPE html><html><head><title>Device Authorized</title></head><body><h1>Device Authorized</h1><p>You can close this window and return to your device.</p></body></html>";
        },
      },
      rpInitiatedLogout: { enabled: true },
      userinfo: { enabled: true },
      revocation: { enabled: true },
      introspection: { enabled: true },
      resourceIndicators: {
        enabled: true,
        defaultResource: async (_ctx, _client, oneOf) => {
          if (typeof oneOf === "string") return oneOf;
          if (Array.isArray(oneOf) && oneOf.length === 1) return oneOf[0];
          return issuer;
        },
        getResourceServerInfo: async (_ctx, resourceIndicator) => {
          if (resourceIndicator !== issuer) {
            throw new Error(`Unknown resource indicator: ${resourceIndicator}`);
          }
          return {
            scope: "openid sign:job users:read users:write users:token device:approve admin",
            audience: issuer,
            accessTokenFormat: "jwt" as const,
            accessTokenTTL: 3600,
            jwt: { sign: { alg: "RS256" as const } },
          };
        },
        useGrantedResource: async () => true,
      },
    },
    ttl: {
      AccessToken: 3600,
      AuthorizationCode: 600,
      DeviceCode: 600,
      IdToken: 3600,
      RefreshToken: 30 * 24 * 3600,
      Interaction: 600,
      Session: 14 * 24 * 3600,
      Grant: 14 * 24 * 3600,
    },
    interactions: {
      policy: buildInteractionPolicy(),
      url: async (_ctx: KoaContextWithOIDC, interaction) => `/oidc/interaction?uid=${interaction.uid}`,
    },
    cookies: {
      keys: (() => {
        const secret = process.env.NEXTAUTH_SECRET;
        if (!secret && process.env.NODE_ENV === "production") {
          throw new Error("NEXTAUTH_SECRET must be set in production. Generate one with: openssl rand -base64 32");
        }
        return [secret ?? "dev-secret-change-me"];
      })(),
      short: {
        httpOnly: true,
        sameSite: "lax" as const,
        path: "/",
      },
    },
    conformIdTokenClaims: false,
    enabledJWA: { idTokenSigningAlgValues: ["RS256"] },
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

  providerInstance = new Provider(issuer, configuration);
  patchHashedClientSecretComparison(providerInstance);
  providerInstance.proxy = true;
  await getCorsSnapshot();

  if (cleanupInterval) clearInterval(cleanupInterval);
  cleanupInterval = setInterval(() => {
    PostgresOidcAdapter.cleanup().catch((err) => console.error("Oidc cleanup failed", err));
  }, 10 * 60 * 1000);

  return providerInstance;
}

export function resetProvider(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
  corsCache = null;
  corsCacheExpiry = 0;
  providerInstance = null;
}
