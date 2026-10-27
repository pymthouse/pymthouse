import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db/index";
import { developerApps, oidcClients, users } from "@/db/schema";

export async function listReviewableApps() {
  return db
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
    .where(inArray(developerApps.status, ["submitted", "in_review", "approved", "rejected"]));
}

export async function clearPendingRevisionReview(params: {
  appId: string;
  notes: string | null;
  updatedAt: string;
  setJwksUri: string | null;
}) {
  await db
    .update(developerApps)
    .set({
      pendingScopes: null,
      pendingGrantTypes: null,
      pendingRevisionSubmittedAt: null,
      reviewerNotes: params.notes,
      updatedAt: params.updatedAt,
      ...(params.setJwksUri ? { jwksUri: params.setJwksUri } : {}),
    })
    .where(eq(developerApps.id, params.appId));
}

export async function updateInitialReviewState(params: {
  appId: string;
  newStatus: "approved" | "rejected";
  notes: string | null;
  reviewerUserId: string;
  reviewedAt: string;
  setJwksUri: string | null;
}) {
  await db
    .update(developerApps)
    .set({
      status: params.newStatus,
      reviewerNotes: params.notes,
      reviewedBy: params.reviewerUserId,
      reviewedAt: params.reviewedAt,
      publishedAt: params.newStatus === "approved" ? params.reviewedAt : null,
      updatedAt: params.reviewedAt,
      ...(params.setJwksUri ? { jwksUri: params.setJwksUri } : {}),
    })
    .where(eq(developerApps.id, params.appId));
}

export async function revokeApprovedApp(appId: string, now: string) {
  return db
    .update(developerApps)
    .set({
      status: "submitted",
      submittedAt: now,
      updatedAt: now,
      reviewerNotes: null,
      reviewedBy: null,
      reviewedAt: null,
    })
    .where(and(eq(developerApps.id, appId), eq(developerApps.status, "approved")))
    .returning({ id: developerApps.id });
}

export async function setMarketplaceFeatured(appId: string, featured: boolean, updatedAt: string) {
  await db
    .update(developerApps)
    .set({
      marketplaceFeatured: featured ? 1 : 0,
      updatedAt,
    })
    .where(eq(developerApps.id, appId));
}
