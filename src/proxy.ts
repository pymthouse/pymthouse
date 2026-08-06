import { NextResponse, type NextRequest } from "next/server";

import {
  buildApiCorsHeaders,
  resolveBuilderApiCorsOrigin,
} from "@/lib/api-cors";

/**
 * Node.js request proxy: conditional CORS for `/api/v1/*`.
 *
 * - App routes `/api/v1/apps/{clientId}/…`: Origin must be on that app's domain allowlist
 *   (App Settings → Domain allowlist), or localhost.
 * - Other `/api/v1/…`: platform allow (env, NEXTAUTH_URL, localhost, *.kongportals.com)
 *   or Origin present on any app's allowlist.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (!pathname.startsWith("/api/v1")) {
    return NextResponse.next();
  }

  const origin = request.headers.get("origin");
  const allowOrigin = await resolveBuilderApiCorsOrigin(origin, pathname);
  const corsHeaders = allowOrigin ? buildApiCorsHeaders(allowOrigin) : null;

  if (request.method === "OPTIONS") {
    return new NextResponse(null, {
      status: 204,
      headers: corsHeaders ?? { Vary: "Origin" },
    });
  }

  const response = NextResponse.next();
  if (corsHeaders) {
    for (const [key, value] of Object.entries(corsHeaders)) {
      response.headers.set(key, value);
    }
  }
  return response;
}

export const config = {
  matcher: ["/api/v1/:path*"],
};
