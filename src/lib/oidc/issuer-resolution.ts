import { getCanonicalIssuer, getPublicOrigin } from "./issuer-urls";
import { db } from "@/db/index";
import { developerApps } from "@/db/schema";
import { eq } from "drizzle-orm";

export interface IssuerConfig {
  issuer: string;
  origin: string;
  isCanonical: boolean;
  appId: string | null;
  appName: string | null;
}

export function resolveIssuer(host?: string): IssuerConfig {
  const canonicalIssuer = getCanonicalIssuer();
  const canonicalOrigin = getPublicOrigin();

  return {
    issuer: canonicalIssuer,
    origin: canonicalOrigin,
    isCanonical: true,
    appId: null,
    appName: null,
  };
}

export async function resolveIssuerForApp(appId: string): Promise<IssuerConfig> {
  const appRows = await db
    .select()
    .from(developerApps)
    .where(eq(developerApps.id, appId))
    .limit(1);
  const app = appRows[0];

  const canonicalIssuer = getCanonicalIssuer();
  const canonicalOrigin = getPublicOrigin();

  if (!app) {
    return {
      issuer: canonicalIssuer,
      origin: canonicalOrigin,
      isCanonical: true,
      appId: null,
      appName: null,
    };
  }

  if (app.customIssuerEnabled && app.customIssuerUrl) {
    let origin = "";
    try {
      origin = new URL(app.customIssuerUrl).origin;
    } catch (err) {
      console.error(
        `[issuer-resolution] Malformed customIssuerUrl for app ${app.id}: ${app.customIssuerUrl}`,
        err,
      );
    }
    return {
      issuer: app.customIssuerUrl,
      origin,
      isCanonical: false,
      appId: app.id,
      appName: app.name,
    };
  }

  return {
    issuer: canonicalIssuer,
    origin: canonicalOrigin,
    isCanonical: true,
    appId: app.id,
    appName: app.name,
  };
}

export function resolveIssuerForClientId(clientId: string): IssuerConfig {
  return {
    issuer: getCanonicalIssuer(),
    origin: getPublicOrigin(),
    isCanonical: true,
    appId: null,
    appName: null,
  };
}

export function getEffectiveIssuer(): string {
  return getCanonicalIssuer();
}

export function isIssuerTrusted(issuer: string): boolean {
  const canonicalIssuer = getCanonicalIssuer();
  
  try {
    const issuerUrl = new URL(issuer);
    const canonicalUrl = new URL(canonicalIssuer);
    
    return issuerUrl.origin === canonicalUrl.origin &&
           issuerUrl.pathname === canonicalUrl.pathname;
  } catch {
    return false;
  }
}

export function getIssuerForTokenValidation(): string {
  return getCanonicalIssuer();
}

export function buildDiscoveryUrl(issuerConfig: IssuerConfig): string {
  return `${issuerConfig.issuer}/.well-known/openid-configuration`;
}

export function buildJwksUrl(issuerConfig: IssuerConfig): string {
  return `${issuerConfig.issuer}/jwks`;
}

export function buildAuthorizationUrl(issuerConfig: IssuerConfig): string {
  return `${issuerConfig.issuer}/auth`;
}

export function buildTokenUrl(issuerConfig: IssuerConfig): string {
  return `${issuerConfig.issuer}/token`;
}

export function buildUserinfoUrl(issuerConfig: IssuerConfig): string {
  return `${issuerConfig.issuer}/userinfo`;
}

export interface MultiIssuerConfig {
  enabled: boolean;
  supportedIssuers: string[];
  defaultIssuer: string;
}

export function getMultiIssuerConfig(): MultiIssuerConfig {
  const canonicalIssuer = getCanonicalIssuer();
  
  return {
    enabled: false,
    supportedIssuers: [canonicalIssuer],
    defaultIssuer: canonicalIssuer,
  };
}

export function canEnableCustomIssuer(_appId: string): { allowed: boolean; reason?: string } {
  return {
    allowed: false,
    reason: "Custom per-tenant issuers are not yet supported. This feature is planned for a future release.",
  };
}

export function validateCustomIssuerUrl(url: string): { valid: boolean; error?: string } {
  try {
    const parsed = new URL(url);
    
    if (parsed.protocol !== "https:") {
      return { valid: false, error: "Custom issuer URL must use HTTPS" };
    }
    
    if (parsed.pathname !== "/" && !parsed.pathname.endsWith("/")) {
      return { valid: false, error: "Custom issuer URL should end with a trailing slash" };
    }
    
    return { valid: true };
  } catch {
    return { valid: false, error: "Invalid URL format" };
  }
}
