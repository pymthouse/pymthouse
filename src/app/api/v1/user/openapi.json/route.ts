import { NextResponse } from "next/server";
import { buildPublicOpenApiDocument } from "@/lib/openapi/document";
import "@/lib/openapi/routes";

export const dynamic = "force-dynamic";

/** Alias of the public OpenAPI document (End-user included in main). */
export async function GET() {
  const doc = buildPublicOpenApiDocument();
  return NextResponse.json(doc, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
      Link: '</api/v1/openapi.json>; rel="canonical"',
    },
  });
}
