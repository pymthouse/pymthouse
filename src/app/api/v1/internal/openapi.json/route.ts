import { NextResponse } from "next/server";
import { buildInternalOpenApiDocument } from "@/lib/openapi/document";
import "@/lib/openapi/routes";

export const dynamic = "force-dynamic";

export async function GET() {
  const doc = buildInternalOpenApiDocument();
  return NextResponse.json(doc, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    },
  });
}
