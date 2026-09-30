import { NextRequest, NextResponse } from "next/server";
import { clearCookieOptions } from "@/lib/turnkey-github-cookies";
import {
  openWalletHandoff,
  WALLET_HANDOFF_COOKIE,
} from "@/lib/turnkey-wallet-handoff";

export const dynamic = "force-dynamic";

/** One-shot handoff of the Turnkey session and optional wallet-issuer attach token. */
export function POST(request: NextRequest) {
  const handoff = openWalletHandoff(request.cookies.get(WALLET_HANDOFF_COOKIE)?.value);
  if (!handoff) {
    return NextResponse.json({ error: "No pending wallet session" }, { status: 404 });
  }
  const response = NextResponse.json({
    sessionToken: handoff.sessionToken,
    callbackUrl: handoff.callbackUrl,
    attach: handoff.attach ?? null,
  });
  response.cookies.set(WALLET_HANDOFF_COOKIE, "", clearCookieOptions());
  return response;
}
