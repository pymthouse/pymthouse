import { NextResponse } from "next/server";
import { db } from "@/db/index";
import { developerApps } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getProviderApp } from "@/lib/provider-apps";
import { withSessionAdminGuardParams } from "@/lib/api-guards";

export const PATCH = withSessionAdminGuardParams<{ id: string }>(
  async (request, { params }) => {
    const { id: appIdOrClientId } = await params;
    const app = await getProviderApp(appIdOrClientId);

    if (!app) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (app.status !== "approved") {
      return NextResponse.json(
        { error: "Only approved apps can be featured on the marketplace" },
        { status: 400 },
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const featured =
      typeof body === "object" && body !== null
        ? (body as { featured?: unknown }).featured
        : undefined;

    if (typeof featured !== "boolean") {
      return NextResponse.json(
        { error: "Body must include featured: boolean" },
        { status: 400 },
      );
    }

    const now = new Date().toISOString();
    const marketplaceFeatured = featured ? 1 : 0;

    await db
      .update(developerApps)
      .set({
        marketplaceFeatured,
        updatedAt: now,
      })
      .where(eq(developerApps.id, app.id));

    return NextResponse.json({
      success: true,
      featured,
    });
  },
);
