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
import { resetProvider } from "@/lib/oidc/provider";
import { ensureConfidentialWebIdentityScopes } from "@/lib/oidc/scopes";

/** Stable first-party RP id. Override with `CS_OIDC_CLIENT_ID` if already provisioned. */
export const CUSTOMER_SERVICE_OIDC_CLIENT_ID = "web_customer_service";

export const CUSTOMER_SERVICE_OIDC_DISPLAY_NAME = "Customer Service";

export const DEFAULT_CUSTOMER_SERVICE_ORIGIN = "http://localhost:3010";

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

export function getCustomerServiceOidcClientId(): string {
  return process.env.CS_OIDC_CLIENT_ID?.trim() || CUSTOMER_SERVICE_OIDC_CLIENT_ID;
}

export function resolveCustomerServiceRedirectUris(): string[] {
  const explicit = process.env.CS_OIDC_REDIRECT_URI?.trim();
  if (explicit) {
    return mergeRedirectUris([], explicit.split(/[\s,]+/));
  }
  const origin = (
    process.env.CUSTOMER_SERVICE_URL?.trim() ||
    process.env.NEXT_PUBLIC_CUSTOMER_SERVICE_URL?.trim() ||
    DEFAULT_CUSTOMER_SERVICE_ORIGIN
  ).replace(/\/+$/, "");
  return [`${origin}/api/auth/callback/pymthouse`];
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
 * later runs merge redirects and repair scopes/grants; the secret is
 * minted on create (or when missing) and only rotated when asked.
 */
export async function ensureCustomerServiceOidcClient(opts?: {
  clientId?: string;
  redirectUris?: string[];
  rotateSecret?: boolean;
}): Promise<EnsureCustomerServiceOidcClientResult> {
  const clientId = opts?.clientId?.trim() || getCustomerServiceOidcClientId();
  const desiredRedirects =
    opts?.redirectUris !== undefined
      ? mergeRedirectUris([], opts.redirectUris)
      : resolveCustomerServiceRedirectUris();

  const existingRows = await db
    .select()
    .from(oidcClients)
    .where(eq(oidcClients.clientId, clientId))
    .limit(1);
  const existing = existingRows[0];

  if (!existing) {
    if (desiredRedirects.length === 0) {
      throw new Error(
        "Customer-service OIDC client requires at least one redirect URI.",
      );
    }
    const secret = generateClientSecret();
    const grantTypes = syncConfidentialWebGrantTypes(
      [...DEFAULT_CONFIDENTIAL_WEB_GRANT_TYPES],
      desiredRedirects,
    );
    await db.insert(oidcClients).values({
      id: uuidv4(),
      clientId,
      clientSecretHash: hashClientSecret(secret),
      displayName: CUSTOMER_SERVICE_OIDC_DISPLAY_NAME,
      redirectUris: JSON.stringify(desiredRedirects),
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
      redirectUris: desiredRedirects,
    };
  }

  const redirectUris = mergeRedirectUris(
    JSON.parse(existing.redirectUris) as string[],
    desiredRedirects,
  );
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
