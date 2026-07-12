import { docsHtmlResponse, scalarDocsHtml } from "@/lib/openapi/docs-html";

export const dynamic = "force-dynamic";

/** Public API reference (Builder + End-user). Internal is not linked here. */
export async function GET() {
  return docsHtmlResponse(
    scalarDocsHtml({
      title: "PymtHouse API",
      openApiUrl: "/api/v1/openapi.json",
    }),
  );
}
