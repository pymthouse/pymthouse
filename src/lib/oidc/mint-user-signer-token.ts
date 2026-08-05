import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/db/index";
import { developerApps, oidcClients } from "@/db/schema";
import { validateClientSecret } from "@/lib/oidc/clients";
import { ACCESS_TOKEN_JWT_TYP, ensureSigningKey } from "@/lib/oidc/jwks";
import { getIssuer } from "@/lib/oidc/issuer-urls";
import { AppActivationError } from "@/lib/activation/app-activation";
import {
  provisionAppUserBilling,
} from "@/lib/billing/provision-app-user";
import { seedSignerSpendableBalance } from "@/lib/oidc/signer-balance-gate";
import { isHostedAdminClientAvailable } from "@/lib/openmeter/admin-client";
import { buildOwnerWireSubject } from "@/lib/openmeter/customer-key";
import { hasPositiveUsdMicrosBalance } from "@/lib/format-usd-micros";
import type { TrialCreditBalance } from "@/lib/openmeter/entitlements";
import { getSpendableAllowanceDetails } from "@/lib/openmeter/spendable-allowance";
import type { ResolvedBillingIdentity } from "@/lib/openmeter/billing-identity";
import { SIGN_MINT_USER_TOKEN_SCOPE } from "@/lib/oidc/scopes";
import { buildSignerSessionEnvelope } from "@/lib/openapi/signer-session";
import { buildDiscoverOrchestratorsUrl } from "@/lib/discovery-service-url";
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
  const signerUrl = getClientSignerApiUrl(publicClientId);
  return buildSignerSessionEnvelope({
    access_token: minted.access_token,
    expires_in: minted.expires_in,
    scope: minted.scope,
    balanceUsdMicros: minted.balanceUsdMicros,
    lifetimeGrantedUsdMicros: minted.lifetimeGrantedUsdMicros,
    signer_url: signerUrl,
    discovery_url: buildDiscoverOrchestratorsUrl(signerUrl),
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
  options?: { allowsOverageInvoicing?: boolean },
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
  // remainders still authorize. Spendable allowance already ceils fractional
  // meter sums once at the read boundary (exact ingest, no per-ticket ceil).
  if (!hasPositiveUsdMicrosBalance(allowance.balanceUsdMicros)) {
    // Owner Paid + chargeable PM: overage invoices charge_automatically.
    // Sandbox Starter never uses this path — hard balance gate only.
    if (options?.allowsOverageInvoicing) {
      return null;
    }
    return {
      code: "trial_credits_exhausted",
      message: "Payment method required",
    };
  }
  return null;
}

export function enforceMintAllowanceGate(
  allowance: TrialCreditBalance | null,
  options?: { allowsOverageInvoicing?: boolean },
): void {
  const decision = mintAllowanceGateDecision(
    allowance,
    isHostedAdminClientAvailable(),
    options,
  );
  if (decision) {
    throw new MintUserSignerTokenError(decision.code, decision.message, 402);
  }
}

async function provisionForMintOrThrow(input: {
  developerAppId: string;
  externalUserId: string;
}): Promise<void> {
  try {
    await provisionAppUserBilling({
      clientId: input.developerAppId,
      externalUserId: input.externalUserId,
    });
  } catch (err) {
    if (err instanceof AppActivationError) {
      throw new MintUserSignerTokenError(err.code, err.message, err.status);
    }
    if (isHostedAdminClientAvailable()) {
      throw new MintUserSignerTokenError(
        "billing_unavailable",
        err instanceof Error ? err.message : "Billing provisioning failed",
        402,
      );
    }
    throw err;
  }
}

async function loadMintAllowance(input: {
  provisionExternalUserId: string;
  identity: ResolvedBillingIdentity;
}): Promise<TrialCreditBalance | null> {
  if (!isHostedAdminClientAvailable()) {
    return null;
  }
  const spendable = await getSpendableAllowanceDetails({
    clientId: input.identity.publicClientId,
    externalUserId: input.provisionExternalUserId,
    identity: input.identity,
  });
  if (spendable == null) {
    return null;
  }
  const gateSubject = input.identity.isOwner
    ? buildOwnerWireSubject(input.provisionExternalUserId)
    : input.provisionExternalUserId;
  // Seed under the same client id the webhook balance gate looks up
  // (UsageIdentity.client_id === public OIDC client id).
  seedSignerSpendableBalance(
    input.identity.publicClientId,
    gateSubject,
    spendable.spendableUsdMicros,
  );
  return {
    hasAccess: BigInt(spendable.spendableUsdMicros) > 0n,
    balanceUsdMicros: spendable.spendableUsdMicros,
    // Not surfaced in the signer envelope; the mint gate reads balance only.
    consumedUsdMicros: "0",
    lifetimeGrantedUsdMicros: spendable.grantedUsdMicros,
  };
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

  await provisionForMintOrThrow({
    developerAppId: identity.developerAppId,
    externalUserId: provisionExternalUserId,
  });

  const allowance = await loadMintAllowance({
    provisionExternalUserId,
    identity,
  });
  let allowsOverageInvoicing = false;
  if (identity.isOwner && identity.ownerUserId) {
    const { ownerWalletAllowsOverageInvoicing } = await import(
      "@/lib/openmeter/owner-paid-plan"
    );
    allowsOverageInvoicing = await ownerWalletAllowsOverageInvoicing(
      identity.ownerUserId,
    );
  }
  enforceMintAllowanceGate(allowance, { allowsOverageInvoicing });

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
