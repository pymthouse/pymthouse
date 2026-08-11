import { NextRequest, NextResponse } from "next/server";

import {
  NetworkAgentRegisterError,
  clientIpFromRequest,
  createRegisterChallenge,
} from "@/lib/network-agent-register";

/**
 * Issue a short-lived Ed25519 challenge for headless agent network registration.
 * Requires `?publicKey=` (hex or base64 raw/SPKI Ed25519 public key).
 */
export async function GET(request: NextRequest) {
  const publicKey = request.nextUrl.searchParams.get("publicKey")?.trim() || "";
  if (!publicKey) {
    return NextResponse.json(
      { error: "publicKey query parameter is required" },
      { status: 400 },
    );
  }

  try {
    const challenge = await createRegisterChallenge({
      publicKey,
      clientIp: clientIpFromRequest(request),
    });
    return NextResponse.json({
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      expiresAt: challenge.expiresAt,
      alg: challenge.alg,
    });
  } catch (err) {
    if (err instanceof NetworkAgentRegisterError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    }
    console.error("Network agent challenge failed:", err);
    return NextResponse.json(
      { error: "Failed to create registration challenge" },
      { status: 500 },
    );
  }
}
