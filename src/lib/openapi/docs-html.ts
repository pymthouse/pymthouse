import { NextResponse } from "next/server";

import {
  API_V1_PREFIX,
  API_V2_PREFIX,
  type ApiVersion,
} from "@/lib/api-version/v2-surface";

const SCALAR_CDN =
  "https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.61.0";
const SCALAR_INTEGRITY =
  "sha384-uoZh8fmeR7WslZnYZCGmhZPuYhNd27YRZG/XpABR1/IbkjbdQhmUmn6Xyceh5ikg";

/** One document in Scalar's multi-document picker. */
export type ScalarDocSource = {
  title: string;
  slug: string;
  url: string;
  default?: boolean;
};

/** Public API reference sources: v2 (current) and v1 (legacy). */
export function publicApiDocSources(defaultVersion: ApiVersion): ScalarDocSource[] {
  return [
    {
      title: "v2 (current)",
      slug: "v2",
      url: `${API_V2_PREFIX}/openapi.json`,
      default: defaultVersion === "v2",
    },
    {
      title: "v1 (legacy)",
      slug: "v1",
      url: `${API_V1_PREFIX}/openapi.json`,
      default: defaultVersion === "v1",
    },
  ];
}

/**
 * Scalar API reference page. `sources` renders Scalar's document picker via
 * `data-configuration` (no inline script, so the CSP below still applies).
 */
export function scalarDocsHtml(
  input:
    | { title: string; openApiUrl: string }
    | { title: string; sources: ScalarDocSource[] },
): string {
  const title = escapeHtml(input.title);
  const specAttribute =
    "sources" in input
      ? `data-configuration="${escapeHtml(JSON.stringify({ sources: input.sources }))}"`
      : `data-url="${escapeHtml(input.openApiUrl)}"`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>body { margin: 0; }</style>
  </head>
  <body>
    <script
      id="api-reference"
      ${specAttribute}
      src="${SCALAR_CDN}"
      integrity="${SCALAR_INTEGRITY}"
      crossorigin="anonymous"></script>
  </body>
</html>`;
}

export function docsHtmlResponse(html: string): NextResponse {
  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'",
    },
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
