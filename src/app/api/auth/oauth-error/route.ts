import { NextRequest, NextResponse } from "next/server";

import { completeOauthErrorNoticePost } from "@/lib/oauth-error-notice";
import { getPublicOrigin } from "@/lib/oidc/issuer-urls";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const notice = form.get("notice");
  return completeOauthErrorNoticePost(
    typeof notice === "string" ? notice : "",
  );
}

export async function GET() {
  const url = new URL("/login", getPublicOrigin());
  url.searchParams.set("error", "InvalidOauthState");
  return NextResponse.redirect(url, 303);
}
