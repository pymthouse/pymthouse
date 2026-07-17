import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/db/index";
import { developerApps, oidcClients } from "@/db/schema";
import { validateClientSecret } from "@/lib/oidc/clients";
import { ACCESS_TOKEN_JWT_TYP, ensureSigningKey } from "@/lib/oidc/jwks";
import { getIssuer } from "@/lib/oidc/issuer-urls";
import {
  ensureAppUserKonnectCustomer,
  provisionAppUserBilling,
} from "@/lib/billing/provision-app-user";
import { isHostedAdminClientAvailable } from "@/lib/openmeter/admin-client";
import { hasPositiveUsdMicrosBalance } from "@/lib/format-usd-micros";
import type { TrialCreditBalance } from "@/lib/openmeter/entitlements";
import { SIGN_MINT_USER_TOKEN_SCOPE } from "@/lib/oidc/scopes";
import { buildSignerSessionEnvelope } from "@/lib/openapi/signer-session";
import { getClientSignerApiUrl } from "@/lib/signer-proxy";

export { SIGN_MINT_USER_TOKEN_SCOPE };
const SIGNER_JWT_TTL_SECONDS = 300;

export class MintUserSignerTokenError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function parseRequestedScopes(scopeParam: string | null | undefined): string[] {
  return (scopeParam || SIGN_MINT_USER_TOKEN_SCOPE)
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isMintUserSignerTokenRequest(params: URLSearchParams): boolean {
  if (params.get("grant_type") !== "client_credentials") {
    return false;
  }
  const scopes = parseRequestedScopes(params.get("scope"));
  return scopes.includes(SIGN_MINT_USER_TOKEN_SCOPE);
}

function parseClientCredentialsScopes(scopeParam: string | null | undefined): string[] {
  return (scopeParam || "")
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

async function authenticateM2mClient(clientId: string, clientSecret: string) {
  if (!(await validateClientSecret(clientId, clientSecret))) {
    throw new MintUserSignerTokenError("invalid_client", "Invalid client credentials", 401);
  }

  const appRows = await db
    .select({
      appId: developerApps.id,
      ownerId: developerApps.ownerId,
    })
    .from(developerApps)
    .innerJoin(oidcClients, eq(developerApps.m2mOidcClientId, oidcClients.id))
    .where(eq(oidcClients.clientId, clientId))
    .limit(1);

  const row = appRows[0];
  if (!row) {
    throw new MintUserSignerTokenError("invalid_client", "Unknown M2M client", 401);
  }
  return row;
}

async function loadM2mAllowedScopes(clientId: string): Promise<Set<string>> {
  const m2mScopeRows = await db
    .select({ allowedScopes: oidcClients.allowedScopes })
    .from(oidcClients)
    .where(eq(oidcClients.clientId, clientId))
    .limit(1);
  return new Set(
    (m2mScopeRows[0]?.allowedScopes || "")
      .split(/[\s,]+/)
      .map((scope) => scope.trim())
      .filter(Boolean),
  );
}

async function loadPublicSignJobClient(appId: string) {
  const publicClientRows = await db
    .select({ allowedScopes: oidcClients.allowedScopes, clientId: oidcClients.clientId })
    .from(developerApps)
    .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(eq(developerApps.id, appId))
    .limit(1);
  const publicClient = publicClientRows[0];
  if (!publicClient?.allowedScopes.includes("sign:job")) {
    throw new MintUserSignerTokenError(
      "invalid_scope",
      "Public app client must allow sign:job",
    );
  }
  return publicClient;
}

function signerSessionFromMint(
  minted: Awaited<ReturnType<typeof mintSignerJwtForExternalUser>>,
  publicClientId: string,
) {
  return buildSignerSessionEnvelope({
    access_token: minted.access_token,
    expires_in: minted.expires_in,
    scope: minted.scope,
    balanceUsdMicros: minted.balanceUsdMicros,
    lifetimeGrantedUsdMicros: minted.lifetimeGrantedUsdMicros,
    signer_url: getClientSignerApiUrl(publicClientId),
    issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
  });
}

/** M2M client_credentials with sign:job only — mints a signer JWT for the app owner. */
export function isM2mOwnerSignJobRequest(params: URLSearchParams): boolean {
  if (params.get("grant_type") !== "client_credentials") {
    return false;
  }
  if (params.get("external_user_id")?.trim()) {
    return false;
  }
  const scopes = parseClientCredentialsScopes(params.get("scope"));
  if (!scopes.includes("sign:job")) {
    return false;
  }
  if (scopes.includes(SIGN_MINT_USER_TOKEN_SCOPE)) {
    return false;
  }
  return true;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") {
    end -= 1;
  }
  return value.slice(0, end);
}

/** Signer JWT `aud` matches the OIDC issuer (same as Apache DMZ AuthJWTAud). */
export function signerJwtAudience(): string {
  return trimTrailingSlashes(getIssuer());
}

export function mintAllowanceGateDecision(
  allowance: TrialCreditBalance | null,
  hostedBillingEnabled: boolean,
): { code: "billing_unavailable" | "trial_credits_exhausted"; message: string } | null {
  if (!hostedBillingEnabled) {
    return null;
  }
  if (!allowance) {
    return {
      code: "billing_unavailable",
      message: "Billing allowance could not be confirmed",
    };
  }
  // Derive access from integer micros (not a stale hasAccess flag) so 1–99 micro
  // remainders still authorize after collector ceil-to-micro billing.
  if (!hasPositiveUsdMicrosBalance(allowance.balanceUsdMicros)) {
    return {
      code: "trial_credits_exhausted",
      message: "Starter allowance exhausted",
    };
  }
  return null;
}

export function enforceMintAllowanceGate(allowance: TrialCreditBalance | null): void {
  const decision = mintAllowanceGateDecision(allowance, isHostedAdminClientAvailable());
  if (decision) {
    throw new MintUserSignerTokenError(decision.code, decision.message, 402);
  }
}

export async function mintSignerJwtForExternalUser(input: {
  publicClientId: string;
  developerAppId: string;
  externalUserId: string;
}) {
  const externalUserId = input.externalUserId.trim();
  if (!externalUserId) {
    throw new MintUserSignerTokenError(
      "invalid_request",
      "external_user_id is required",
    );
  }

  const { resolveOpenMeterBillingIdentity } = await import(
    "@/lib/openmeter/billing-identity"
  );
  const identity = await resolveOpenMeterBillingIdentity({
    clientId: input.publicClientId,
    externalUserId,
  });
  // Wire JWT/sub stays the bare platform user id. Owner billing wallet is
  // owner:{users.id} via resolveOpenMeterBillingIdentity / Konnect attribution.
  const provisionExternalUserId = identity.isOwner
    ? (identity.ownerUserId as string)
    : externalUserId;
  const jwtExternalUserId = provisionExternalUserId;

  let allowance: TrialCreditBalance | null;
  try {
    if (isHostedAdminClientAvailable()) {
      await ensureAppUserKonnectCustomer({
        clientId: identity.developerAppId,
        externalUserId: provisionExternalUserId,
      });
    }
    ({ allowance } = await provisionAppUserBilling({
      clientId: identity.developerAppId,
      externalUserId: provisionExternalUserId,
    }));
  } catch (err) {
    if (isHostedAdminClientAvailable()) {
      throw new MintUserSignerTokenError(
        "billing_unavailable",
        err instanceof Error ? err.message : "Billing provisioning failed",
        402,
      );
    }
    throw err;
  }

  // Mint gate uses credits + remaining plan discount (discount covers included usage).
  if (isHostedAdminClientAvailable()) {
    const { getSpendableUsdMicros } = await import("@/lib/openmeter/spendable-allowance");
    const spendable = await getSpendableUsdMicros({
      clientId: identity.publicClientId,
      externalUserId: provisionExternalUserId,
    });
    if (spendable != null) {
      allowance = {
        hasAccess: BigInt(spendable) > 0n,
        balanceUsdMicros: spendable,
        consumedUsdMicros: allowance?.consumedUsdMicros ?? "0",
        lifetimeGrantedUsdMicros: allowance?.lifetimeGrantedUsdMicros ?? "0",
      };
    }
  }

  enforceMintAllowanceGate(allowance);

  const issuer = getIssuer();
  const audience = signerJwtAudience();
  const keyPair = await ensureSigningKey();
  const nowSeconds = Math.floor(Date.now() / 1000);

  const accessToken = await new SignJWT({
    scope: "sign:job",
    scp: ["sign:job"],
    client_id: input.publicClientId,
    external_user_id: jwtExternalUserId,
    user_type: identity.isOwner ? "app_owner" : "external_user",
  })
    .setProtectedHeader({ alg: "RS256", kid: keyPair.kid, typ: ACCESS_TOKEN_JWT_TYP })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(jwtExternalUserId)
    .setJti(uuidv4())
    .setIssuedAt(nowSeconds)
    .setNotBefore(nowSeconds)
    .setExpirationTime(nowSeconds + SIGNER_JWT_TTL_SECONDS)
    .sign(keyPair.privateKey);

  return {
    access_token: accessToken,
    token_type: "Bearer" as const,
    expires_in: SIGNER_JWT_TTL_SECONDS,
    scope: "sign:job",
    balanceUsdMicros: allowance?.balanceUsdMicros ?? "0",
    lifetimeGrantedUsdMicros: allowance?.lifetimeGrantedUsdMicros ?? "0",
  };
}

export async function handleMintUserSignerToken(input: {
  clientId: string;
  clientSecret: string;
  externalUserId: string;
  scope?: string | null;
}) {
  const externalUserId = input.externalUserId?.trim();
  if (!externalUserId) {
    throw new MintUserSignerTokenError(
      "invalid_request",
      "external_user_id is required",
    );
  }

  const row = await authenticateM2mClient(input.clientId, input.clientSecret);

  const m2mScopes = await loadM2mAllowedScopes(input.clientId);
  if (!m2mScopes.has(SIGN_MINT_USER_TOKEN_SCOPE)) {
    throw new MintUserSignerTokenError(
      "invalid_scope",
      `M2M client lacks ${SIGN_MINT_USER_TOKEN_SCOPE}`,
    );
  }

  const publicClient = await loadPublicSignJobClient(row.appId);

  const minted = await mintSignerJwtForExternalUser({
    publicClientId: publicClient.clientId,
    developerAppId: row.appId,
    externalUserId,
  });
  return signerSessionFromMint(minted, publicClient.clientId);
}

export async function handleM2mOwnerSignJob(input: {
  clientId: string;
  clientSecret: string;
}) {
  const row = await authenticateM2mClient(input.clientId, input.clientSecret);

  const m2mScopes = await loadM2mAllowedScopes(input.clientId);
  if (!m2mScopes.has("sign:job")) {
    throw new MintUserSignerTokenError(
      "invalid_scope",
      "M2M client lacks sign:job",
    );
  }

  const publicClient = await loadPublicSignJobClient(row.appId);

  const minted = await mintSignerJwtForExternalUser({
    publicClientId: publicClient.clientId,
    developerAppId: row.appId,
    externalUserId: row.ownerId,
  });
  return signerSessionFromMint(minted, publicClient.clientId);
}
