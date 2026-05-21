import { NextRequest, NextResponse } from "next/server";
import { getAdminUser } from "@/domains/identity-access/runtime/admin-auth";
import {
  issueAdminToken,
  listAdminTokens,
  revokeAdminToken,
} from "@/domains/identity-access/runtime/admin-tokens";

/**
 * POST /api/v1/tokens -- Issue a new bearer token (scoped to an end user or admin)
 */
export async function POST(request: NextRequest) {
  const admin = await getAdminUser(request);
  if (!admin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const scopes = body.scopes || "sign:job";
  const expiresInDays = body.expiresInDays || 90;
  const endUserId = body.endUserId || undefined;
  const label = body.label || undefined;

  const validScopes = ["admin", "sign:job", "read"];
  const scopeList = scopes.split(",").map((s: string) => s.trim());
  for (const scope of scopeList) {
    if (!validScopes.includes(scope)) {
      return NextResponse.json(
        { error: `Invalid scope: ${scope}` },
        { status: 400 }
      );
    }
  }

  if (scopeList.includes("admin") && admin.role !== "admin") {
    return NextResponse.json(
      { error: "Only admins can issue admin-scoped tokens" },
      { status: 403 }
    );
  }

  const { sessionId, token } = await issueAdminToken({
    adminUserId: admin.id,
    endUserId,
    label,
    scopes,
    expiresInDays,
  });

  return NextResponse.json({
    sessionId,
    token,
    scopes,
    endUserId: endUserId || null,
    expiresInDays,
    message: "Store this token securely. It will not be shown again.",
  });
}

/**
 * GET /api/v1/tokens -- List active tokens
 */
export async function GET(request: NextRequest) {
  const admin = await getAdminUser(request);
  if (!admin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const allSessions = await listAdminTokens();

  return NextResponse.json({ tokens: allSessions });
}

/**
 * DELETE /api/v1/tokens -- Revoke a token
 */
export async function DELETE(request: NextRequest) {
  const admin = await getAdminUser(request);
  if (!admin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  if (!body.sessionId) {
    return NextResponse.json(
      { error: "sessionId is required" },
      { status: 400 }
    );
  }

  await revokeAdminToken(body.sessionId);
  return NextResponse.json({ message: "Token revoked" });
}
