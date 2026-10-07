import {
  docsHtmlResponse,
  publicApiDocSources,
  scalarDocsHtml,
} from "@/lib/openapi/docs-html";

export const dynamic = "force-dynamic";

/** Public API reference (Builder + End-user), v2 by default with a v1 picker. */
export async function GET() {
  return docsHtmlResponse(
    scalarDocsHtml({
      title: "PymtHouse Builder API",
      sources: publicApiDocSources("v2"),
    }),
  );
}
