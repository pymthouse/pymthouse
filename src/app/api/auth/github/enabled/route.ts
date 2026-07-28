import { NextResponse } from "next/server";
import { isGithubTurnkeyLoginConfigured } from "@/lib/turnkey-github-auth";

export const dynamic = "force-dynamic";

/** Public flag for the login UI (no secrets). */
export async function GET() {
  return NextResponse.json({
    enabled: isGithubTurnkeyLoginConfigured(),
  });
}
