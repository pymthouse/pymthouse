import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/index";
import { developerApps, oidcClients } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  syncBackendM2mAllowedScopesFromPublicApp,
  updateClientConfig,
} from "@/lib/oidc/clients";
import { resetProvider } from "@/lib/oidc/provider";
import { getProviderApp } from "@/lib/provider-apps";
import { getPlatformJwksUrlForDatabase } from "@/lib/oidc/issuer-urls";
import { withSessionAdminGuardParams } from "@/lib/api-guards";

export const POST = withSessionAdminGuardParams<{ id: string }>(
  async (request, { params }, { userId }) => {
    const { id: clientId } = await params;

    const app = await getProviderApp(clientId);

  if (!app) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await request.json();
  const { action, notes } = body;

  if (action !== "approve" && action !== "reject") {
    return NextResponse.json(
      { error: "action must be 'approve' or 'reject'" },
      { status: 400 }
    );
  }

  const now = new Date().toISOString();

  // Revision review: approved app with pending scope/grant changes
  if (
    app.status === "approved" &&
    app.pendingRevisionSubmittedAt &&
    app.pendingScopes &&
    app.pendingGrantTypes &&
    app.oidcClientId
  ) {
    const clientResults = await db
      .select()
      .from(oidcClients)
      .where(eq(oidcClients.id, app.oidcClientId))
      .limit(1);

    const client = clientResults[0];

    if (action === "approve" && client) {
      await updateClientConfig(client.clientId, {
        allowedScopes: app.pendingScopes,
        grantTypes: app.pendingGrantTypes.split(",").filter(Boolean),
      });
      resetProvider();
      if (await syncBackendM2mAllowedScopesFromPublicApp(app.id)) {
        resetProvider();
      }
    }

    await db.update(developerApps)
      .set({
        pendingScopes: null,
        pendingGrantTypes: null,
        pendingRevisionSubmittedAt: null,
        reviewerNotes: action === "reject" ? notes || null : null,
        updatedAt: now,
        ...(action === "approve"
          ? { jwksUri: getPlatformJwksUrlForDatabase() }
          : {}),
      })
      .where(eq(developerApps.id, app.id));

    return NextResponse.json({
      success: true,
      status: "approved",
      revisionApproved: action === "approve",
    });
  }

  // Initial review: submitted or in_review
  if (app.status !== "submitted" && app.status !== "in_review") {
    return NextResponse.json(
      { error: `Cannot review app with status '${app.status}'` },
      { status: 400 }
    );
  }

  const newStatus = action === "approve" ? "approved" : "rejected";

  await db.update(developerApps)
    .set({
      status: newStatus,
      reviewerNotes: notes || null,
      reviewedBy: userId,
      reviewedAt: now,
      publishedAt: action === "approve" ? now : null,
      updatedAt: now,
      ...(action === "approve"
        ? { jwksUri: getPlatformJwksUrlForDatabase() }
        : {}),
    })
    .where(eq(developerApps.id, app.id));

  return NextResponse.json({ success: true, status: newStatus });
  },
);
