import { NextResponse } from "next/server";
import { getTurnkeyWalletPublicJwks } from "@/lib/turnkey-wallet-oidc";

export const dynamic = "force-dynamic";

/** JWKS Turnkey uses to verify PymtHouse wallet login tokens. */
export async function GET() {
  const jwks = await getTurnkeyWalletPublicJwks();
  return NextResponse.json(jwks, {
    headers: { "Cache-Control": "public, max-age=60" },
  });
}
