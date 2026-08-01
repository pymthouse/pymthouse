import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { buildInternalOpenApiDocument } from "@/lib/openapi/document";
import { authOptions } from "@/lib/next-auth-options";
import "@/lib/openapi/routes";

export const dynamic = "force-dynamic";

/** Internal OpenAPI JSON — session required. */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const doc = buildInternalOpenApiDocument();
  return NextResponse.json(doc, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    },
  });
}
