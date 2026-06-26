import { NextResponse } from "next/server";
import { db } from "@/db/index";
import { developerApps, users, oidcClients } from "@/db/schema";
import { eq, inArray } from "drizzle-orm";
import { withSessionAdminGuard } from "@/lib/api-guards";

export const GET = withSessionAdminGuard(async () => {
  try {
    const apps = await db
      .select({
        id: oidcClients.clientId,
        name: developerApps.name,
        subtitle: developerApps.subtitle,
        category: developerApps.category,
        status: developerApps.status,
        developerName: developerApps.developerName,
        submittedAt: developerApps.submittedAt,
        pendingRevisionSubmittedAt: developerApps.pendingRevisionSubmittedAt,
        createdAt: developerApps.createdAt,
        ownerEmail: users.email,
        ownerName: users.name,
        clientId: oidcClients.clientId,
        marketplaceFeatured: developerApps.marketplaceFeatured,
      })
      .from(developerApps)
      .leftJoin(users, eq(developerApps.ownerId, users.id))
      .leftJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
      .where(
        inArray(developerApps.status, ["submitted", "in_review", "approved", "rejected"])
      );

    return NextResponse.json({ apps: apps || [] });
  } catch (error) {
    console.error("Admin apps API error:", error);
    return NextResponse.json(
      { error: "Failed to load apps", apps: [] },
      { status: 500 },
    );
  }
});
