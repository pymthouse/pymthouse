import { NextResponse, type NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import { getNextAuthSecret } from "@/platform/auth/next-auth-secret";

const SESSION_COOKIE_NAMES = [
  "next-auth.session-token",
  "__Secure-next-auth.session-token",
] as const;

const nextAuthSecret = getNextAuthSecret({ suppressDevWarning: true });

export async function proxy(request: NextRequest) {
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
