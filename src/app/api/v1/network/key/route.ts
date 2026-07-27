import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/next-auth-options";
import { mintDefaultAppNetworkKey } from "@/lib/onboarding";

/**
 * Mint a personal network access key on the platform default app.
 * Available to all developers (Explorer and Builder).
 */
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = (session.user as Record<string, unknown>).id as string;
  if (!userId) {
    return NextResponse.json({ error: "Invalid session" }, { status: 401 });
  }

  const role = (session.user as Record<string, unknown>).role as string | undefined;
  if (role === "admin" || role === "operator") {
    return NextResponse.json(
      { error: "Platform admins do not mint network keys on the default app" },
      { status: 400 },
    );
  }

  const email =
    typeof session.user.email === "string" ? session.user.email : null;

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
        message:
          "Store this API key securely. It will not be shown again. Use the full app_<24hex>_<secret> value as Authorization: Bearer <token> for the remote signer, or use sdkToken as --token with livepeer-python-sdk.",
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
