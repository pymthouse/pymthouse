import { NextResponse } from "next/server";
import { getTurnkeyGithubPublicJwks } from "@/lib/turnkey-github-oidc";

export const dynamic = "force-dynamic";

/** JWKS for Turnkey verification of GitHub BYO OIDC tokens. */
export async function GET() {
  const jwks = await getTurnkeyGithubPublicJwks();
  return NextResponse.json(jwks, {
    headers: {
      "Cache-Control": "public, max-age=60",
    },
  });
}
