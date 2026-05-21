import { NextResponse } from "next/server";
import { fetchPipelineCatalog } from "@/platform/catalog/naap-catalog";

export async function GET() {
  try {
    const catalog = await fetchPipelineCatalog();
    return NextResponse.json(
      { catalog },
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
