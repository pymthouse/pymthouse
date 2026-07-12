import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** @deprecated Prefer `/api/v1/docs` — End-user is in the main document. */
export async function GET(request: Request) {
  return NextResponse.redirect(new URL("/api/v1/docs", request.url), 308);
}
