import { NextResponse } from "next/server";

const SCALAR_CDN =
  "https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.61.0";
const SCALAR_INTEGRITY =
  "sha384-uoZh8fmeR7WslZnYZCGmhZPuYhNd27YRZG/XpABR1/IbkjbdQhmUmn6Xyceh5ikg";

export function scalarDocsHtml(input: {
  title: string;
  openApiUrl: string;
}): string {
  const title = escapeHtml(input.title);
  const openApiUrl = escapeHtml(input.openApiUrl);
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
      data-url="${openApiUrl}"
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
