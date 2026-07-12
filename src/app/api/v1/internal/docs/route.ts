import { docsHtmlResponse, scalarDocsHtml } from "@/lib/openapi/docs-html";

export const dynamic = "force-dynamic";

export async function GET() {
  return docsHtmlResponse(
    scalarDocsHtml({
      title: "PymtHouse Internal API",
      openApiUrl: "/api/v1/internal/openapi.json",
    }),
  );
}
