import { randomBytes } from "crypto";
import {
  getAppByCustomLoginDomain,
  getAppByVerifiedCustomDomain,
  getDeveloperAppById,
  listVerifiedCustomLoginDomainHosts,
  updateCustomDomainVerification,
  updateCustomLoginDomain,
} from "../repo/custom-domains";

export interface CustomDomainConfig {
  appId: string;
  domain: string;
  verified: boolean;
  verificationToken: string | null;
  verifiedAt: string | null;
}

export function generateVerificationToken(): string {
  return `pmth_verify_${randomBytes(16).toString("hex")}`;
}

export function getDnsVerificationRecord(token: string): string {
  return `_pymthouse-verification=${token}`;
}

export function normalizeDomain(domain: string): string {
  return domain.toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "").replace(/^www\./, "");
}

export async function getAppByCustomDomain(domain: string) {
  return getAppByVerifiedCustomDomain(normalizeDomain(domain));
}

export async function isVerifiedCustomDomain(domain: string): Promise<boolean> {
  return (await getAppByCustomDomain(domain)) !== null;
}

export async function verifyDomainOwnership(appId: string, domain: string) {
  const normalized = normalizeDomain(domain);
  const app = await getDeveloperAppById(appId);
  if (!app) return { verified: false, error: "App not found" };
  if (app.customLoginDomain !== normalized) {
    return { verified: false, error: "Domain does not match configured custom login domain" };
  }
  const verificationToken = app.customDomainVerificationToken;
  if (!verificationToken) {
    return { verified: false, error: "No verification token configured" };
  }

  try {
    const { Resolver } = await import("dns/promises");
    const resolver = new Resolver();
    resolver.setServers(["8.8.8.8", "1.1.1.1"]);
    const expectedRecord = getDnsVerificationRecord(verificationToken);
    const records = await resolver.resolveTxt(`_pymthouse.${normalized}`);
    const flatRecords = records.map((r) => r.join(""));
    if (flatRecords.includes(expectedRecord) || flatRecords.includes(verificationToken)) {
      const updated = await updateCustomDomainVerification({
        appId,
        normalizedDomain: normalized,
        verificationToken,
        verifiedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      if (updated.length === 0) {
        return { verified: false, error: "Domain verification state changed, please retry" };
      }
      return { verified: true };
    }
    return {
      verified: false,
      error: `DNS TXT record not found. Add a TXT record for _pymthouse.${normalized} with value: ${verificationToken}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "DNS lookup failed";
    return { verified: false, error: `DNS verification failed: ${message}` };
  }
}

export async function setupCustomLoginDomain(appId: string, domain: string) {
  const normalized = normalizeDomain(domain);
  if (!normalized || normalized.includes("/") || !normalized.includes(".")) {
    return { error: "Invalid domain format" };
  }
  const existing = await getAppByCustomLoginDomain(normalized);
  if (existing && existing.id !== appId) {
    return { error: "This domain is already configured for another app" };
  }
  const token = generateVerificationToken();
  const dnsRecord = getDnsVerificationRecord(token);
  await updateCustomLoginDomain(appId, {
    customLoginDomain: normalized,
    customDomainVerificationToken: token,
    customDomainVerifiedAt: null,
    customLoginEnabled: 0,
    updatedAt: new Date().toISOString(),
  });
  return { token, dnsRecord, dnsHost: `_pymthouse.${normalized}` };
}

export async function enableCustomLoginDomain(appId: string): Promise<boolean> {
  const app = await getDeveloperAppById(appId);
  if (!app || !app.customDomainVerifiedAt) return false;
  await updateCustomLoginDomain(appId, {
    customLoginEnabled: 1,
    brandingMode: "whiteLabel",
    updatedAt: new Date().toISOString(),
  });
  return true;
}

export async function disableCustomLoginDomain(appId: string): Promise<void> {
  await updateCustomLoginDomain(appId, {
    customLoginEnabled: 0,
    updatedAt: new Date().toISOString(),
  });
}

export async function removeCustomLoginDomain(appId: string): Promise<void> {
  await updateCustomLoginDomain(appId, {
    customLoginDomain: null,
    customDomainVerificationToken: null,
    customDomainVerifiedAt: null,
    customLoginEnabled: 0,
    updatedAt: new Date().toISOString(),
  });
}

export async function getCustomDomainStatus(appId: string): Promise<CustomDomainConfig | null> {
  const app = await getDeveloperAppById(appId);
  if (!app || !app.customLoginDomain) return null;
  return {
    appId: app.id,
    domain: app.customLoginDomain,
    verified: !!app.customDomainVerifiedAt,
    verificationToken: app.customDomainVerificationToken,
    verifiedAt: app.customDomainVerifiedAt,
  };
}

export async function getVerifiedCustomLoginDomainHosts(): Promise<string[]> {
  return listVerifiedCustomLoginDomainHosts();
}

export async function getTrustedLoginHosts(): Promise<string[]> {
  const baseHost = process.env.NEXTAUTH_URL
    ? new URL(process.env.NEXTAUTH_URL).host
    : "localhost:3000";
  const verifiedHosts = await getVerifiedCustomLoginDomainHosts();
  return [baseHost, ...verifiedHosts];
}
