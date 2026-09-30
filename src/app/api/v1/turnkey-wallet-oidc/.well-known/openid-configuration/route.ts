import { NextResponse } from "next/server";
import { buildTurnkeyWalletOpenIdConfiguration } from "@/lib/turnkey-wallet-oidc";

export const dynamic = "force-dynamic";

/** OpenID discovery for the PymtHouse wallet issuer. */
export async function GET() {
  return NextResponse.json(buildTurnkeyWalletOpenIdConfiguration(), {
    headers: { "Cache-Control": "public, max-age=60" },
  });
}
