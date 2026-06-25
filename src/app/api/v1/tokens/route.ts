import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/next-auth-options";
import { db } from "@/db/index";
import { sessions, users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { createSession, revokeSession, authenticateRequest, hasScope } from "@/lib/auth";
import {
  AdminTokenIssueRequestSchema,
  AdminTokenRevokeRequestSchema,
} from "@/lib/openapi/schemas/misc";

/**
 * POST /api/v1/tokens -- Issue a new bearer token (scoped to an end user or admin)
 */
export async function POST(request: NextRequest) {
  const admin = await getAdminUser(request);
  if (!admin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rawBody = await request.json();
  const parsed = AdminTokenIssueRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
      { status: 400 },
    );
  }
  const body = parsed.data;
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

  const { sessionId, token } = await createSession({
    userId: admin.id,
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

  const allSessions = await db
    .select({
      id: sessions.id,
      label: sessions.label,
      endUserId: sessions.endUserId,
      scopes: sessions.scopes,
      expiresAt: sessions.expiresAt,
      createdAt: sessions.createdAt,
    })
    .from(sessions);

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

  const rawBody = await request.json();
  const parsed = AdminTokenRevokeRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "sessionId is required" },
      { status: 400 },
    );
  }

  await revokeSession(parsed.data.sessionId);
  return NextResponse.json({ message: "Token revoked" });
}

async function getAdminUser(request: NextRequest) {
  const oauthSession = await getServerSession(authOptions);
  if (oauthSession?.user) {
    const sessionUser = oauthSession.user as Record<string, unknown>;
    if (sessionUser.id) {
      const rows = await db
        .select()
        .from(users)
        .where(eq(users.id, sessionUser.id as string))
        .limit(1);
      return rows[0];
    }
  }

  const auth = await authenticateRequest(request);
  if (auth && hasScope(auth.scopes, "admin") && auth.userId) {
    const rows = await db
      .select()
      .from(users)
      .where(eq(users.id, auth.userId))
      .limit(1);
    return rows[0];
  }

  return null;
}
