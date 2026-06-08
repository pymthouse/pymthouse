import { NextRequest, NextResponse } from "next/server";
import { handleRemoteSignerAuthorize } from "@pymthouse/builder-sdk/signer/webhook";
import { readPymthouseSignerWebhookConfig } from "@/lib/signer-webhook";

export const runtime = "nodejs";

/**
 * Remote signer auth webhook (go-livepeer PR #3897).
 * Verifies end-user JWT from forwarded gateway headers and runs platform gating.
 */
export async function POST(request: NextRequest) {
  try {
    const config = readPymthouseSignerWebhookConfig();
    const response = await handleRemoteSignerAuthorize(request, config);
    const body = await response.text();
    return new NextResponse(body, {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("content-type") ?? "application/json",
      },
    });
  } catch {
    return NextResponse.json(
      { status: 500, reason: "webhook misconfigured" },
      { status: 500 },
    );
  }
}
