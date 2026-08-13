import { NextResponse, type NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

import {
  buildApiCorsHeaders,
  resolveBuilderApiCorsOrigin,
} from "@/lib/api-cors";
import { isOidcHandshakePath } from "@/lib/oidc/handshake-path";
import { getNextAuthSecret } from "@/lib/next-auth-secret";

const SESSION_COOKIE_NAMES = [
  "next-auth.session-token",
  "__Secure-next-auth.session-token",
] as const;

const nextAuthSecret = getNextAuthSecret({ suppressDevWarning: true });

/**
 * Node.js request proxy:
 * - Conditional CORS for `/api/v1/*`
 * - Clear invalid/mismatched NextAuth session cookies on other routes
 * - Leave OIDC authorize/interaction/resume responses alone (those Set-Cookie
 *   headers are the handshake; wiping NextAuth here restarts login).
 *
 * CORS:
 * - App routes `/api/v1/apps/{clientId}/…`: Origin must be on that app's domain allowlist
 *   (App Settings → Domain allowlist), or localhost (non-production / opt-in).
 * - Other `/api/v1/…`: platform allow (env, NEXTAUTH_URL, localhost, *.kongportals.com);
 *   tenant-shared allowlist fallback only for public metadata paths.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  let corsHeaders: Record<string, string> | null = null;

  if (pathname === "/api/v1" || pathname.startsWith("/api/v1/")) {
    try {
      const origin = request.headers.get("origin");
      const allowOrigin = await resolveBuilderApiCorsOrigin(origin, pathname);
      corsHeaders = allowOrigin ? buildApiCorsHeaders(allowOrigin) : null;
    } catch (err) {
      console.error("Builder API CORS resolution failed:", err);
      corsHeaders = null;
    }

    if (request.method === "OPTIONS") {
      return new NextResponse(null, {
        status: 204,
        headers: corsHeaders ?? { Vary: "Origin" },
      });
    }
  }

  const response = await resolveSessionCookieResponse(request);

  if (corsHeaders) {
    for (const [key, value] of Object.entries(corsHeaders)) {
      response.headers.set(key, value);
    }
  }
  return response;
}

async function resolveSessionCookieResponse(
  request: NextRequest,
): Promise<NextResponse> {
  if (isOidcHandshakePath(request.nextUrl.pathname)) {
    return NextResponse.next();
  }

  const hasSessionCookie = SESSION_COOKIE_NAMES.some((name) =>
    Boolean(request.cookies.get(name)?.value),
  );
  if (!hasSessionCookie || !nextAuthSecret) {
    return NextResponse.next();
  }

  try {
    const token = await getToken({ req: request, secret: nextAuthSecret });
    if (token) {
      return NextResponse.next();
    }
  } catch {
    // Invalid/mismatched encrypted cookie should be removed below.
  }

  const response = NextResponse.next();
  const isHttps = request.nextUrl.protocol === "https:";

  for (const name of SESSION_COOKIE_NAMES) {
    response.cookies.set({
      name,
      value: "",
      maxAge: 0,
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: isHttps,
    });
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)",
  ],
};
