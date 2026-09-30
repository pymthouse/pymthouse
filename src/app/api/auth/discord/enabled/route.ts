import { NextResponse } from "next/server";
import { isDiscordWalletLoginConfigured } from "@/lib/turnkey-discord-auth";
import { isTurnkeyBackendAuthEnabled } from "@/lib/turnkey-backend-auth";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    enabled: isTurnkeyBackendAuthEnabled() && isDiscordWalletLoginConfigured(),
  });
}
