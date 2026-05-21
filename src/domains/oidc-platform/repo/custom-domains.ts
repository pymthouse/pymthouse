import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db/index";
import { developerApps } from "@/db/schema";

export async function getDeveloperAppById(appId: string) {
  const rows = await db.select().from(developerApps).where(eq(developerApps.id, appId)).limit(1);
  return rows[0] ?? null;
}

export async function getAppByVerifiedCustomDomain(domain: string) {
  const rows = await db
    .select()
    .from(developerApps)
    .where(
      and(
        eq(developerApps.customLoginDomain, domain),
        eq(developerApps.customLoginEnabled, 1),
      ),
    )
    .limit(1);
  const app = rows[0];
  if (!app || !app.customDomainVerifiedAt) return null;
  return app;
}

export async function getAppByCustomLoginDomain(domain: string) {
  const rows = await db
    .select()
    .from(developerApps)
    .where(eq(developerApps.customLoginDomain, domain))
    .limit(1);
  return rows[0] ?? null;
}

export async function updateCustomDomainVerification(params: {
  appId: string;
  normalizedDomain: string;
  verificationToken: string;
  verifiedAt: string;
  updatedAt: string;
}) {
  return db
    .update(developerApps)
    .set({
      customDomainVerifiedAt: params.verifiedAt,
      updatedAt: params.updatedAt,
    })
    .where(
      and(
        eq(developerApps.id, params.appId),
        eq(developerApps.customLoginDomain, params.normalizedDomain),
        eq(developerApps.customDomainVerificationToken, params.verificationToken),
      ),
    )
    .returning({ id: developerApps.id });
}

export async function updateCustomLoginDomain(appId: string, updates: {
  customLoginDomain?: string | null;
  customDomainVerificationToken?: string | null;
  customDomainVerifiedAt?: string | null;
  customLoginEnabled?: number;
  brandingMode?: string;
  updatedAt: string;
}) {
  await db.update(developerApps).set(updates).where(eq(developerApps.id, appId));
}

export async function listVerifiedCustomLoginDomainHosts() {
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
