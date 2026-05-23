import { NextRequest, NextResponse } from "next/server";
import {
  fetchPipelineCatalogForApp,
  resolveCatalogServiceTypeForApp,
  resolveCatalogServiceTypesForApp,
} from "@/lib/catalog-for-app";
import { getProviderApp } from "@/lib/provider-apps";

/**
 * GET /api/v1/apps/:id/pipeline-catalog
 *
 * Pipeline catalog filtered by the app's Livepeer signing mode:
 * legacy → legacy capabilities; LPNM → registry; dual → union of both.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const app = await getProviderApp(clientId);
  if (!app) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const [catalog, serviceType, serviceTypes] = await Promise.all([
      fetchPipelineCatalogForApp(app.id),
      resolveCatalogServiceTypeForApp(app.id),
      resolveCatalogServiceTypesForApp(app.id),
    ]);
    return NextResponse.json(
      { catalog, serviceType, serviceTypes, signingMode: app.signingMode },
      {
        headers: {
          "Cache-Control": "private, max-age=60, stale-while-revalidate=30",
        },
      },
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to fetch pipeline catalog";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
