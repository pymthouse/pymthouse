import {
  docsHtmlResponse,
  publicApiDocSources,
  scalarDocsHtml,
} from "@/lib/openapi/docs-html";

export const dynamic = "force-dynamic";

/** Public API reference, opened on v1 (legacy) with a picker for v2. */
export async function GET() {
  return docsHtmlResponse(
    scalarDocsHtml({
      title: "PymtHouse Builder API (v1, legacy)",
      sources: publicApiDocSources("v1"),
    }),
  );
}
