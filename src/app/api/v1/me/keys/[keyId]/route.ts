import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/next-auth-options";
import { revokeSessionUserApiKey } from "@/lib/app-api-keys";
import { createCorrelationId, writeAuditLog } from "@/lib/audit";

/**
 * Revoke an API key owned by the signed-in user.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ keyId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = (session.user as Record<string, unknown>).id as string | undefined;
  if (!userId) {
    return NextResponse.json({ error: "Invalid session" }, { status: 401 });
  }

  const role = (session.user as Record<string, unknown>).role as string | undefined;
  if (role === "admin" || role === "operator") {
    return NextResponse.json(
      { error: "Platform admins manage keys per app, not via personal keys" },
      { status: 400 },
    );
  }

  const { keyId: rawKeyId } = await params;
  const keyId = decodeURIComponent(rawKeyId).trim();
  if (!keyId) {
    return NextResponse.json({ error: "keyId is required" }, { status: 400 });
  }

  const revoked = await revokeSessionUserApiKey({
    sessionUserId: userId,
    keyId,
  });
  if (!revoked) {
    return NextResponse.json({ error: "Key not found" }, { status: 404 });
  }

  const correlationId = createCorrelationId();
  await writeAuditLog({
    clientId: null,
    actorUserId: userId,
    action: "api_key_revoked",
    status: "success",
    correlationId,
    metadata: { keyId, scope: "session_user" },
  });

  return NextResponse.json({ success: true, correlation_id: correlationId });
}
