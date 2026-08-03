import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/next-auth-options";
import { mintDefaultAppNetworkKey } from "@/lib/onboarding";
import { PERSONAL_API_KEY_STORE_MESSAGE } from "@/lib/app-api-keys";
import {
  isPersonalKeysSessionResult,
  requirePersonalKeysSession,
} from "@/lib/require-personal-keys-session";

/**
 * Mint a personal network access key on the platform default app.
 * Available to all developers (Explorer and Builder).
 */
export async function POST() {
  const session = await getServerSession(authOptions);
  const gate = requirePersonalKeysSession(session, {
    adminRejectedMessage:
      "Platform admins do not mint network keys on the default app",
  });
  if (!isPersonalKeysSessionResult(gate)) {
    return gate;
  }
  const { userId } = gate;

  const email =
    typeof session?.user?.email === "string" ? session.user.email : null;

  try {
    const result = await mintDefaultAppNetworkKey({
      userId,
      email,
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
        message: PERSONAL_API_KEY_STORE_MESSAGE,
        correlation_id: result.correlationId,
      },
      { status: 201 },
    );
  } catch (err) {
    console.error("Network key mint failed:", err);
    const message =
      err instanceof Error ? err.message : "Failed to mint network access key";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
