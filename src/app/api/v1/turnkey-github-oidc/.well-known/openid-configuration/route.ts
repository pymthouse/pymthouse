import { NextResponse } from "next/server";
import { buildTurnkeyGithubOpenIdConfiguration } from "@/lib/turnkey-github-oidc";

export const dynamic = "force-dynamic";

/** OpenID discovery for Turnkey BYO auth (GitHub OAuth2 wrapper). */
export async function GET() {
  return NextResponse.json(buildTurnkeyGithubOpenIdConfiguration(), {
    headers: {
      "Cache-Control": "public, max-age=60",
    },
  });
}
