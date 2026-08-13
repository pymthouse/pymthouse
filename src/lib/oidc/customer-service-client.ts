import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";

import { db } from "@/db/index";
import { oidcClients } from "@/db/schema";
import {
  generateClientSecret,
  hashClientSecret,
} from "@/lib/oidc/clients";
import {
  DEFAULT_CONFIDENTIAL_WEB_GRANT_TYPES,
  syncConfidentialWebGrantTypes,
} from "@/lib/oidc/confidential-web";
import {
  CUSTOMER_SERVICE_OIDC_DISPLAY_NAME,
  customerServiceCallbackUri,
  getCustomerServiceOidcClientId,
} from "@/lib/oidc/customer-service-id";
import { resetProvider } from "@/lib/oidc/provider";
import { ensureConfidentialWebIdentityScopes } from "@/lib/oidc/scopes";

export {
  CUSTOMER_SERVICE_OIDC_CLIENT_ID,
  CUSTOMER_SERVICE_OIDC_DISPLAY_NAME,
  customerServiceCallbackUri,
  getCustomerServiceOidcClientId,
  getCustomerServiceOrigin,
  isCustomerServiceOidcClient,
  oidcLoginPathForClient,
  oidcLoginRedirect,
} from "@/lib/oidc/customer-service-id";

export const CUSTOMER_SERVICE_OIDC_SCOPES = ensureConfidentialWebIdentityScopes(
  "openid profile admin",
);

export type EnsureCustomerServiceOidcClientResult = {
  clientId: string;
  created: boolean;
  secretRotated: boolean;
  clientSecret: string | null;
  redirectUris: string[];
};

/** True when pymthouse env explicitly names CS redirect or origin (not NEXTAUTH_URL fallback). */
export function hasConfiguredCustomerServiceRedirectOrigin(): boolean {
  return Boolean(
    process.env.CS_OIDC_REDIRECT_URI?.trim() ||
      process.env.CUSTOMER_SERVICE_URL?.trim() ||
      process.env.NEXT_PUBLIC_CUSTOMER_SERVICE_URL?.trim(),
  );
}

export function resolveCustomerServiceRedirectUris(): string[] {
  const explicit = process.env.CS_OIDC_REDIRECT_URI?.trim();
  if (explicit) {
    return mergeRedirectUris([], explicit.split(/[\s,]+/));
  }
  return [customerServiceCallbackUri()];
}

/** Redirects to merge on update; empty when CS origin env is unset (avoids localhost on prod re-bootstrap). */
export function desiredCustomerServiceRedirectUrisForEnsure(
  opts?: { redirectUris?: string[] },
): string[] {
  if (opts?.redirectUris !== undefined) {
    return mergeRedirectUris([], opts.redirectUris);
  }
  if (!hasConfiguredCustomerServiceRedirectOrigin()) {
    return [];
  }
  return resolveCustomerServiceRedirectUris();
}

export function mergeRedirectUris(
  existing: string[],
  desired: string[],
): string[] {
  const out: string[] = [];
  for (const raw of [...existing, ...desired]) {
    const uri = raw.trim();
    if (uri.length > 0 && !out.includes(uri)) {
      out.push(uri);
    }
  }
  return out;
}

/**
 * Ensure the first-party customer-service confidential web RP exists.
 * Not a developer app — a standalone `oidc_clients` row. Idempotent:
 * later runs merge redirects when CS redirect env is set, repair scopes/grants;
 * minted on create (or when missing) and only rotated when asked.
 */
export async function ensureCustomerServiceOidcClient(opts?: {
  clientId?: string;
  redirectUris?: string[];
  rotateSecret?: boolean;
}): Promise<EnsureCustomerServiceOidcClientResult> {
  const clientId = opts?.clientId?.trim() || getCustomerServiceOidcClientId();
  const desiredRedirects = desiredCustomerServiceRedirectUrisForEnsure(opts);

  const existingRows = await db
    .select()
    .from(oidcClients)
    .where(eq(oidcClients.clientId, clientId))
    .limit(1);
  const existing = existingRows[0];

  if (!existing) {
    const redirectsForCreate =
      desiredRedirects.length > 0
        ? desiredRedirects
        : resolveCustomerServiceRedirectUris();
    if (redirectsForCreate.length === 0) {
      throw new Error(
        "Customer-service OIDC client requires at least one redirect URI.",
      );
    }
    const secret = generateClientSecret();
    const grantTypes = syncConfidentialWebGrantTypes(
      [...DEFAULT_CONFIDENTIAL_WEB_GRANT_TYPES],
      redirectsForCreate,
    );
    await db.insert(oidcClients).values({
      id: uuidv4(),
      clientId,
      clientSecretHash: hashClientSecret(secret),
      displayName: CUSTOMER_SERVICE_OIDC_DISPLAY_NAME,
      redirectUris: JSON.stringify(redirectsForCreate),
      allowedScopes: CUSTOMER_SERVICE_OIDC_SCOPES,
      grantTypes: grantTypes.join(","),
      tokenEndpointAuthMethod: "client_secret_post",
    });
    resetProvider();
    return {
      clientId,
      created: true,
      secretRotated: true,
      clientSecret: secret,
      redirectUris: redirectsForCreate,
    };
  }

  const existingRedirects = JSON.parse(existing.redirectUris) as string[];
  const redirectUris =
    desiredRedirects.length > 0
      ? mergeRedirectUris(existingRedirects, desiredRedirects)
      : existingRedirects;
  if (redirectUris.length === 0) {
    throw new Error(
      "Customer-service OIDC client requires at least one redirect URI.",
    );
  }

  const grantTypes = syncConfidentialWebGrantTypes(
    [...DEFAULT_CONFIDENTIAL_WEB_GRANT_TYPES],
    redirectUris,
  );
  const mintSecret = opts?.rotateSecret === true || !existing.clientSecretHash;
  const secret = mintSecret ? generateClientSecret() : null;

  await db
    .update(oidcClients)
    .set({
      displayName: CUSTOMER_SERVICE_OIDC_DISPLAY_NAME,
      redirectUris: JSON.stringify(redirectUris),
      allowedScopes: CUSTOMER_SERVICE_OIDC_SCOPES,
      grantTypes: grantTypes.join(","),
      tokenEndpointAuthMethod: "client_secret_post",
      ...(secret ? { clientSecretHash: hashClientSecret(secret) } : {}),
    })
    .where(eq(oidcClients.clientId, clientId));
  resetProvider();

  return {
    clientId,
    created: false,
    secretRotated: Boolean(secret),
    clientSecret: secret,
    redirectUris,
  };
}
