import { NextRequest, NextResponse } from "next/server";
import { getPublicMarketplaceApp } from "@/domains/developer-apps/runtime/public-marketplace";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: routeId } = await params;
  const app = await getPublicMarketplaceApp(routeId);
  if (!app) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(app);
}
