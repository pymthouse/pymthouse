import { NextResponse } from "next/server";
import { buildOpenIdProviderDiscovery } from "@/lib/oidc/as-metadata";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(buildOpenIdProviderDiscovery(), {
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "application/json",
    },
  });
}
