import { NextResponse } from "next/server";
import { db } from "@/db/index";
import { developerApps, oidcClients } from "@/db/schema";
import { and, eq, isNotNull } from "drizzle-orm";
import { notPlatformDefaultApp } from "@/lib/platform-default-app";

export async function GET() {
  const rows = await db
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
    .where(
      and(
        eq(developerApps.status, "approved"),
        isNotNull(developerApps.publishedAt),
        notPlatformDefaultApp(),
      ),
    );

  const apps = rows.map(({ marketplaceFeatured, webOidcClientId, ...app }) => ({
    ...app,
    clientId: webOidcClientId,
    featured: marketplaceFeatured === 1,
  }));

  return NextResponse.json({ apps });
}
