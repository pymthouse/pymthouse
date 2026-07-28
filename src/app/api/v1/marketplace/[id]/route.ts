import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/index";
import { developerApps, oidcClients } from "@/db/schema";
import { eq, and, isNotNull } from "drizzle-orm";
import { notPlatformDefaultApp } from "@/lib/platform-default-app";

function publishedApprovedCondition() {
  return and(
    eq(developerApps.status, "approved"),
    isNotNull(developerApps.publishedAt),
    notPlatformDefaultApp(),
  );
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: routeId } = await params;

  const baseSelect = {
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

  // Prefer developer app id (stable public key). Fall back to legacy web OIDC client_id in URL.
  const byAppId = await db
    .select(baseSelect)
    .from(developerApps)
    .leftJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(and(eq(developerApps.id, routeId), publishedApprovedCondition()))
    .limit(1);

  const row =
    byAppId[0] ??
    (
      await db
        .select(baseSelect)
        .from(developerApps)
        .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
        .where(
          and(
            eq(oidcClients.clientId, routeId),
            publishedApprovedCondition(),
          ),
        )
        .limit(1)
    )[0];

  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { marketplaceFeatured, webOidcClientId, ...app } = row;
  return NextResponse.json({
    ...app,
    clientId: webOidcClientId,
    featured: marketplaceFeatured === 1,
  });
}
