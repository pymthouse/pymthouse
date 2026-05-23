import { NextRequest, NextResponse } from "next/server";
import { fetchPipelineCatalog } from "@/lib/naap-catalog";
import type { CatalogServiceType } from "@/lib/signing-modes";

function parseServiceType(value: string | null): CatalogServiceType | undefined {
  if (value === "legacy" || value === "registry") {
    return value;
  }
  return undefined;
}

export async function GET(request: NextRequest) {
  const serviceType = parseServiceType(
    request.nextUrl.searchParams.get("serviceType"),
  );

  try {
    const catalog = await fetchPipelineCatalog(
      serviceType ? { serviceType } : undefined,
    );
    return NextResponse.json(
      { catalog, serviceType: serviceType ?? null },
      {
        headers: {
          "Cache-Control": "public, max-age=300, stale-while-revalidate=60",
        },
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch pipeline catalog";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
