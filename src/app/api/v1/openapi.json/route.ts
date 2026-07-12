import { NextResponse } from "next/server";
import { buildPublicOpenApiDocument } from "@/lib/openapi/document";
import "@/lib/openapi/routes";

export const dynamic = "force-dynamic";

/** Public OpenAPI — Builder (M2M) + End-user. */
export async function GET() {
  const doc = buildPublicOpenApiDocument();
  return NextResponse.json(doc, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    },
  });
}
