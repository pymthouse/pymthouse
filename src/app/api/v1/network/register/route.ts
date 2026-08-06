import { NextRequest, NextResponse } from "next/server";

import {
  NetworkAgentRegisterError,
  clientIpFromRequest,
  registerNetworkAgent,
} from "@/lib/network-agent-register";

type RegisterBody = {
  publicKey?: unknown;
  challengeId?: unknown;
  signature?: unknown;
  label?: unknown;
};

/**
 * Headless agent registration on the platform default app.
 * Proves Ed25519 key possession; returns a one-time composite API key.
 * Does not create a platform `users` / Turnkey account.
 */
export async function POST(request: NextRequest) {
  let body: RegisterBody;
  try {
    body = (await request.json()) as RegisterBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const publicKey = typeof body.publicKey === "string" ? body.publicKey : "";
  const challengeId =
    typeof body.challengeId === "string" ? body.challengeId : "";
  const signature = typeof body.signature === "string" ? body.signature : "";
  const label = typeof body.label === "string" ? body.label : null;

  if (!publicKey || !challengeId || !signature) {
    return NextResponse.json(
      { error: "publicKey, challengeId, and signature are required" },
      { status: 400 },
    );
  }

  try {
    const result = await registerNetworkAgent({
      publicKey,
      challengeId,
      signature,
      label,
      clientIp: clientIpFromRequest(request),
    });

    return NextResponse.json(
      {
        clientId: result.clientId,
        externalUserId: result.externalUserId,
        apiKey: result.apiKey,
        sdkToken: result.sdkToken,
        id: result.keyId,
        prefix: result.prefix,
        suffix: result.suffix,
        label: result.label,
        message:
          "Store this API key securely. It will not be shown again. Use the full app_<24hex>_<secret> value as Authorization: Bearer <token> for the remote signer, or use sdkToken as --token with livepeer-python-sdk.",
        correlation_id: result.correlationId,
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof NetworkAgentRegisterError) {
      if (err.code === "conflict") {
        return NextResponse.json(
          {
            error: err.message,
            code: err.code,
            clientId: err.details?.clientId,
            externalUserId: err.details?.externalUserId,
            message: err.message,
          },
          { status: 409 },
        );
      }
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    }
    console.error("Network agent register failed:", err);
    const message =
      err instanceof Error ? err.message : "Failed to register network agent";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
