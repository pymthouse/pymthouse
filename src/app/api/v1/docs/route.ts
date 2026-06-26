import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const scalarHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>PymtHouse Builder API</title>
    <style>body { margin: 0; }</style>
  </head>
  <body>
    <script
      id="api-reference"
      data-url="/api/v1/openapi.json"
      src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.61.0"
      integrity="sha384-uoZh8fmeR7WslZnYZCGmhZPuYhNd27YRZG/XpABR1/IbkjbdQhmUmn6Xyceh5ikg"
      crossorigin="anonymous"></script>
  </body>
</html>`;

export async function GET() {
  return new NextResponse(scalarHtml, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'",
    },
  });
}
