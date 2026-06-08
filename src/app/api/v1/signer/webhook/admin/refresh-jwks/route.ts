import { NextRequest, NextResponse } from "next/server";
import { handleRemoteSignerRefreshJwks } from "@pymthouse/builder-sdk/signer/webhook";
import { readPymthouseOidcWebhookConfig } from "@/lib/signer-webhook";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const config = readPymthouseOidcWebhookConfig();
    const response = await handleRemoteSignerRefreshJwks(request, config);
    const body = await response.text();
    return new NextResponse(body, {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("content-type") ?? "application/json",
      },
    });
  } catch {
    return new NextResponse("webhook misconfigured", { status: 500 });
  }
}
