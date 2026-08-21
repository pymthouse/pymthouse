import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { docsHtmlResponse, scalarDocsHtml } from "@/lib/openapi/docs-html";
import { authOptions } from "@/lib/next-auth-options";

export const dynamic = "force-dynamic";

/** Internal API reference — session required. */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return docsHtmlResponse(
    scalarDocsHtml({
      title: "PymtHouse Internal API",
      openApiUrl: "/api/v1/internal/openapi.json",
    }),
  );
}
