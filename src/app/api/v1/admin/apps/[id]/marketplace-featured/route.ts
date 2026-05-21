import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/platform/auth/next-auth-options";
import { getProviderApp } from "@/domains/developer-apps/repo/provider-access";
import { setMarketplaceFeatured } from "@/domains/developer-apps/repo/admin-apps";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const role = (session.user as Record<string, unknown>).role as string;
  if (role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

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

  let body: { featured?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.featured !== "boolean") {
    return NextResponse.json(
      { error: "Body must include featured: boolean" },
      { status: 400 },
    );
  }

  const now = new Date().toISOString();
  await setMarketplaceFeatured(app.id, body.featured, now);

  return NextResponse.json({
    success: true,
    featured: body.featured,
  });
}
