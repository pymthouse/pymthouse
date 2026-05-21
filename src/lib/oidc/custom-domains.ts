import { db } from "@/db/index";
import { developerApps } from "@/db/schema";
import { eq, and, isNotNull } from "drizzle-orm";
import { randomBytes } from "crypto";

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

export async function getAppByCustomDomain(
  domain: string,
): Promise<typeof developerApps.$inferSelect | null> {
  const normalized = normalizeDomain(domain);

  const rows = await db
    .select()
    .from(developerApps)
    .where(
      and(
        eq(developerApps.customLoginDomain, normalized),
        eq(developerApps.customLoginEnabled, 1),
      ),
    )
    .limit(1);
  const app = rows[0];

  if (!app || !app.customDomainVerifiedAt) {
    return null;
  }

  return app;
}

export async function isVerifiedCustomDomain(domain: string): Promise<boolean> {
  const app = await getAppByCustomDomain(domain);
  return app !== null;
}

export async function verifyDomainOwnership(
  appId: string,
  domain: string,
): Promise<{ verified: boolean; error?: string }> {
  const normalized = normalizeDomain(domain);

  const appRows = await db
    .select()
    .from(developerApps)
    .where(eq(developerApps.id, appId))
    .limit(1);
  const app = appRows[0];

  if (!app) {
    return { verified: false, error: "App not found" };
  }

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
      const updated = await db
        .update(developerApps)
        .set({
          customDomainVerifiedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(developerApps.id, appId),
            eq(developerApps.customLoginDomain, normalized),
            eq(developerApps.customDomainVerificationToken, verificationToken),
          ),
        )
        .returning({ id: developerApps.id });

      if (updated.length === 0) {
        return {
          verified: false,
          error: "Domain verification state changed, please retry",
        };
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

export async function setupCustomLoginDomain(
  appId: string,
  domain: string,
): Promise<{ token: string; dnsRecord: string; dnsHost: string } | { error: string }> {
  const normalized = normalizeDomain(domain);

  if (!normalized || normalized.includes("/") || !normalized.includes(".")) {
    return { error: "Invalid domain format" };
  }

  const existingRows = await db
    .select()
    .from(developerApps)
    .where(eq(developerApps.customLoginDomain, normalized))
    .limit(1);
  const existing = existingRows[0];

  if (existing && existing.id !== appId) {
    return { error: "This domain is already configured for another app" };
  }

  const token = generateVerificationToken();
  const dnsRecord = getDnsVerificationRecord(token);

  await db
    .update(developerApps)
    .set({
      customLoginDomain: normalized,
      customDomainVerificationToken: token,
      customDomainVerifiedAt: null,
      customLoginEnabled: 0,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(developerApps.id, appId));

  return {
    token,
    dnsRecord,
    dnsHost: `_pymthouse.${normalized}`,
  };
}

export async function enableCustomLoginDomain(appId: string): Promise<boolean> {
  const appRows = await db
    .select()
    .from(developerApps)
    .where(eq(developerApps.id, appId))
    .limit(1);
  const app = appRows[0];

  if (!app || !app.customDomainVerifiedAt) {
    return false;
  }

  await db
    .update(developerApps)
    .set({
      customLoginEnabled: 1,
      brandingMode: "whiteLabel",
      updatedAt: new Date().toISOString(),
    })
    .where(eq(developerApps.id, appId));

  return true;
}

export async function disableCustomLoginDomain(appId: string): Promise<void> {
  await db
    .update(developerApps)
    .set({
      customLoginEnabled: 0,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(developerApps.id, appId));
}

export async function removeCustomLoginDomain(appId: string): Promise<void> {
  await db
    .update(developerApps)
    .set({
      customLoginDomain: null,
      customDomainVerificationToken: null,
      customDomainVerifiedAt: null,
      customLoginEnabled: 0,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(developerApps.id, appId));
}

export async function getCustomDomainStatus(
  appId: string,
): Promise<CustomDomainConfig | null> {
  const appRows = await db
    .select()
    .from(developerApps)
    .where(eq(developerApps.id, appId))
    .limit(1);
  const app = appRows[0];

  if (!app || !app.customLoginDomain) {
    return null;
  }

  return {
    appId: app.id,
    domain: app.customLoginDomain,
    verified: !!app.customDomainVerifiedAt,
    verificationToken: app.customDomainVerificationToken,
    verifiedAt: app.customDomainVerifiedAt,
  };
}

/**
 * Custom login hostnames that are enabled and DNS-verified (`customDomainVerifiedAt`).
 * Excludes the platform base host from `NEXTAUTH_URL`.
 */
export async function getVerifiedCustomLoginDomainHosts(): Promise<string[]> {
  const rows = await db
    .select({ domain: developerApps.customLoginDomain })
    .from(developerApps)
    .where(
      and(
        eq(developerApps.customLoginEnabled, 1),
        isNotNull(developerApps.customDomainVerifiedAt),
        isNotNull(developerApps.customLoginDomain),
      ),
    );

  return rows.map((row) => row.domain as string);
}

/** Platform login host plus {@link getVerifiedCustomLoginDomainHosts} (verified custom domains only). */
export async function getTrustedLoginHosts(): Promise<string[]> {
  const baseHost = process.env.NEXTAUTH_URL
    ? new URL(process.env.NEXTAUTH_URL).host
    : "localhost:3001";

  const verifiedDomains = await getVerifiedCustomLoginDomainHosts();
  return [baseHost, ...verifiedDomains];
}
