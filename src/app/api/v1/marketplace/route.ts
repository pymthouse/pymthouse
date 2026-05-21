import { NextResponse } from "next/server";
import { getPublicMarketplaceApps } from "@/domains/developer-apps/runtime/public-marketplace";

export async function GET() {
  const apps = await getPublicMarketplaceApps();
  return NextResponse.json({ apps });
}
