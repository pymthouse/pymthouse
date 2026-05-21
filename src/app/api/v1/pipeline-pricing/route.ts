import { NextRequest, NextResponse } from "next/server";
import { fetchDashboardPricing } from "@/platform/catalog/naap-catalog";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const pipeline = url.searchParams.get("pipeline") ?? undefined;
  const model = url.searchParams.get("model") ?? undefined;

  try {
    const rows = await fetchDashboardPricing();
    const filtered =
      pipeline !== undefined
        ? rows.filter(
            (r) =>
              r.pipeline === pipeline &&
              (model === undefined || r.model === model),
          )
        : rows;
    return NextResponse.json(
      { pricing: filtered },
      {
        headers: {
          "Cache-Control": "public, max-age=60, stale-while-revalidate=30",
        },
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch pricing";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
