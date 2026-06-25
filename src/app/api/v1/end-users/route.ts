import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/next-auth-options";
import { db } from "@/db/index";
import { endUsers, users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { authenticateRequest, hasScope } from "@/lib/auth";
import {
  findOrCreateEndUser,
  normalizeWalletAddress,
  verifyTurnkeySessionJwt,
} from "@/lib/turnkey";
import { resolveAttestedWalletAddress } from "@/lib/turnkey/attest-wallet";

/**
 * GET /api/v1/end-users -- List end users (admin auth) or get current end user (Turnkey session JWT)
 */
export async function GET(request: NextRequest) {
  const adminUser = await getAdminUser(request);
  if (adminUser) {
    const allEndUsers = await db.select().from(endUsers);
    return NextResponse.json({ endUsers: allEndUsers });
  }

  const turnkeyJwt = getTurnkeySessionJwtFromRequest(request);
  if (turnkeyJwt) {
    const claims = await verifyTurnkeySessionJwt(turnkeyJwt);
    if (!claims) {
      return NextResponse.json(
        { error: "Invalid Turnkey session" },
        { status: 401 },
      );
    }

    const endUserRows = await db
      .select()
      .from(endUsers)
      .where(eq(endUsers.turnkeyUserId, claims.userId))
      .limit(1);
    const endUser = endUserRows[0];

    if (!endUser) {
      return NextResponse.json(
        { error: "End user not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({ endUser });
  }

  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

/**
 * POST /api/v1/end-users -- Register a new end user (Turnkey session JWT) or create one (admin auth)
 */
export async function POST(request: NextRequest) {
  const body = await request.json();

  const adminUser = await getAdminUser(request);
  if (adminUser) {
    const id = uuidv4();
    await db.insert(endUsers).values({
      id,
      turnkeyUserId: body.turnkeyUserId || null,
      walletAddress: normalizeWalletAddress(body.walletAddress),
      turnkeySubOrgId: body.turnkeySubOrgId || null,
    });

    const createdRows = await db
      .select()
      .from(endUsers)
      .where(eq(endUsers.id, id))
      .limit(1);
    const created = createdRows[0];

    return NextResponse.json({ endUser: created }, { status: 201 });
  }

  const turnkeyJwtPost = getTurnkeySessionJwtFromRequest(request);
  if (turnkeyJwtPost) {
    const claims = await verifyTurnkeySessionJwt(turnkeyJwtPost);
    if (!claims) {
      return NextResponse.json(
        { error: "Invalid Turnkey session" },
        { status: 401 },
      );
    }

    // Prefer the address Turnkey attests for this sub-org over client input.
    const { walletAddress: walletForBind } = await resolveAttestedWalletAddress({
      organizationId: claims.organizationId,
      clientHint: body.walletAddress,
    });

    const { id, isNew } = await findOrCreateEndUser(
      claims.userId,
      walletForBind ?? undefined,
      claims.organizationId,
    );

    const endUserRowsPost = await db
      .select()
      .from(endUsers)
      .where(eq(endUsers.id, id))
      .limit(1);
    const endUser = endUserRowsPost[0];

    return NextResponse.json(
      { endUser, isNew },
      { status: isNew ? 201 : 200 },
    );
  }

  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

async function getAdminUser(request: NextRequest) {
  const oauthSession = await getServerSession(authOptions);
  if (oauthSession?.user) {
    const sessionUser = oauthSession.user as Record<string, unknown>;
    if (sessionUser.id && typeof sessionUser.id === "string" && sessionUser.role === "admin") {
      const rows = await db
        .select()
        .from(users)
        .where(eq(users.id, sessionUser.id))
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

function getTurnkeySessionJwtFromRequest(request: NextRequest): string | null {
  const header = request.headers.get("x-turnkey-session")?.trim();
  if (header) return header;

  const auth = request.headers.get("authorization")?.trim();
  if (auth?.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim() || null;
  }

  return null;
}
