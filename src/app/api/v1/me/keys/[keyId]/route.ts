import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/next-auth-options";
import { revokeSessionUserApiKey } from "@/lib/app-api-keys";
import { createCorrelationId, writeAuditLog } from "@/lib/audit";
import {
  isPersonalKeysSessionResult,
  requirePersonalKeysSession,
} from "@/lib/require-personal-keys-session";

/**
 * Revoke an API key owned by the signed-in user.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ keyId: string }> },
) {
  const session = await getServerSession(authOptions);
  const gate = requirePersonalKeysSession(session);
  if (!isPersonalKeysSessionResult(gate)) {
    return gate;
  }
  const { userId } = gate;

  const { keyId: rawKeyId } = await params;
  let keyId: string;
  try {
    keyId = decodeURIComponent(rawKeyId).trim();
  } catch {
    return NextResponse.json({ error: "keyId is required" }, { status: 400 });
  }
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
    clientId: revoked.developerAppId,
    actorUserId: userId,
    action: "api_key_revoked",
    status: "success",
    correlationId,
    metadata: { keyId, scope: "session_user" },
  });

  return NextResponse.json({ success: true, correlation_id: correlationId });
}
