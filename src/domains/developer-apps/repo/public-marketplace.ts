import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db/index";
import { developerApps, oidcClients } from "@/db/schema";

export function publishedApprovedCondition() {
  return and(
    eq(developerApps.status, "approved"),
    isNotNull(developerApps.publishedAt),
  );
}

export function getPublicMarketplaceSelect() {
  return {
    id: developerApps.id,
    name: developerApps.name,
    subtitle: developerApps.subtitle,
    description: developerApps.description,
    category: developerApps.category,
    logoLightUrl: developerApps.logoLightUrl,
    logoDarkUrl: developerApps.logoDarkUrl,
    developerName: developerApps.developerName,
    websiteUrl: developerApps.websiteUrl,
    supportUrl: developerApps.supportUrl,
    privacyPolicyUrl: developerApps.privacyPolicyUrl,
    tosUrl: developerApps.tosUrl,
    webOidcClientId: oidcClients.clientId,
    grantTypes: oidcClients.grantTypes,
    createdAt: developerApps.createdAt,
    marketplaceFeatured: developerApps.marketplaceFeatured,
  };
}

export async function listPublishedMarketplaceApps() {
  return db
    .select({
      id: developerApps.id,
      name: developerApps.name,
      subtitle: developerApps.subtitle,
      description: developerApps.description,
      category: developerApps.category,
      logoLightUrl: developerApps.logoLightUrl,
      logoDarkUrl: developerApps.logoDarkUrl,
      developerName: developerApps.developerName,
      websiteUrl: developerApps.websiteUrl,
      supportUrl: developerApps.supportUrl,
      webOidcClientId: oidcClients.clientId,
      createdAt: developerApps.createdAt,
      marketplaceFeatured: developerApps.marketplaceFeatured,
    })
    .from(developerApps)
    .leftJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(publishedApprovedCondition());
}

export async function getPublishedMarketplaceAppByAppId(routeId: string) {
  return db
    .select(getPublicMarketplaceSelect())
    .from(developerApps)
    .leftJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(and(eq(developerApps.id, routeId), publishedApprovedCondition()))
    .limit(1);
}

export async function getPublishedMarketplaceAppByClientId(routeId: string) {
  return db
    .select(getPublicMarketplaceSelect())
    .from(developerApps)
    .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(
      and(
        eq(oidcClients.clientId, routeId),
        publishedApprovedCondition(),
      ),
    )
    .limit(1);
}
