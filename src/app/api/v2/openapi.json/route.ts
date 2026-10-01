import { NextResponse } from "next/server";
import { buildPublicOpenApiDocument } from "@/lib/openapi/document";
import "@/lib/openapi/routes";

export const dynamic = "force-dynamic";

/** Public OpenAPI v2 (current) — Builder (M2M) + End-user. */
export async function GET() {
  const doc = buildPublicOpenApiDocument({ version: "v2" });
  return NextResponse.json(doc, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    },
  });
}
