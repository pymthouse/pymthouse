import { and, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/db/index";
import { appAllowedDomains } from "@/db/schema";

export async function listAppDomains(appId: string) {
  return db.select().from(appAllowedDomains).where(eq(appAllowedDomains.appId, appId));
}

export async function ensureAppDomains(appId: string, domains: string[]) {
  const existingDomains = await listAppDomains(appId);
  const existingSet = new Set(existingDomains.map((d) => d.domain.toLowerCase()));

  for (const domain of domains) {
    const normalized = domain.toLowerCase();
    if (!existingSet.has(normalized)) {
      await db.insert(appAllowedDomains).values({
        id: uuidv4(),
        appId,
        domain,
      });
      existingSet.add(normalized);
    }
  }
}

export async function insertAppDomain(appId: string, domain: string) {
  const domainId = uuidv4();
  await db.insert(appAllowedDomains).values({
    id: domainId,
    appId,
    domain,
  });
  return domainId;
}

export async function deleteAppDomain(appId: string, domainId: string) {
  await db
    .delete(appAllowedDomains)
    .where(and(eq(appAllowedDomains.id, domainId), eq(appAllowedDomains.appId, appId)));
}
