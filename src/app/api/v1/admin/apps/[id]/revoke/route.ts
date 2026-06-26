import { NextResponse } from "next/server";
import { db } from "@/db/index";
import { developerApps } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getProviderApp } from "@/lib/provider-apps";
import { withSessionAdminGuardParams } from "@/lib/api-guards";

/**
 * POST /api/v1/admin/apps/[id]/revoke
 * Revokes an approved app, reverting it to "submitted" (non-production).
 * The app returns to the review queue for re-approval.
 */
export const POST = withSessionAdminGuardParams<{ id: string }>(
  async (_request, { params }) => {
    const { id: clientId } = await params;

    const app = await getProviderApp(clientId);
    if (!app) {
      return NextResponse.json(
        { error: "App not found or not in approved status" },
        { status: 404 }
      );
    }

    const now = new Date().toISOString();
    const updated = await db.update(developerApps)
      .set({
        status: "submitted",
        submittedAt: now,
        updatedAt: now,
        reviewerNotes: null,
        reviewedBy: null,
        reviewedAt: null,
      })
      .where(and(eq(developerApps.id, app.id), eq(developerApps.status, "approved")))
      .returning({ id: developerApps.id });

    if (updated.length === 0) {
      return NextResponse.json(
        { error: "App not found or not in approved status" },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true, status: "submitted" });
  },
);
