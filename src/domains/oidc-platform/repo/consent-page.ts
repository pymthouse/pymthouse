import { eq } from "drizzle-orm";
import { db } from "@/db/index";
import { developerApps, oidcClients } from "@/db/schema";

export async function getConsentDeveloperAppByOidcClientRowId(oidcClientRowId: string) {
  const rows = await db
    .select({
      name: developerApps.name,
      developerName: developerApps.developerName,
      websiteUrl: developerApps.websiteUrl,
      privacyPolicyUrl: developerApps.privacyPolicyUrl,
      supportUrl: developerApps.supportUrl,
      logoLightUrl: developerApps.logoLightUrl,
    })
    .from(developerApps)
    .where(eq(developerApps.oidcClientId, oidcClientRowId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getConsentClientMetadataByClientId(clientId: string) {
  const rows = await db
    .select({ logoUri: oidcClients.logoUri })
    .from(oidcClients)
    .where(eq(oidcClients.clientId, clientId))
    .limit(1);
  return rows[0] ?? null;
}
