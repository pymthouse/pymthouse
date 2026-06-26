import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/index";
import { endUsers } from "@/db/schema";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { resolveAdmin } from "@/lib/api-guards";
import {
  findOrCreateEndUser,
  verifyTurnkeySessionJwt,
} from "@/lib/turnkey";

/**
 * GET /api/v1/end-users -- List end users (admin auth) or get current end user (Turnkey session JWT)
 */
export async function GET(request: NextRequest) {
  const adminUser = await resolveAdmin(request);
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

  const adminUser = await resolveAdmin(request);
  if (adminUser) {
    const id = uuidv4();
    await db.insert(endUsers).values({
      id,
      turnkeyUserId: body.turnkeyUserId || null,
      walletAddress: body.walletAddress || null,
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

    const { id, isNew } = await findOrCreateEndUser(
      claims.userId,
      body.walletAddress,
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

function getTurnkeySessionJwtFromRequest(request: NextRequest): string | null {
  const header = request.headers.get("x-turnkey-session")?.trim();
  if (header) return header;

  const auth = request.headers.get("authorization")?.trim();
  if (auth?.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim() || null;
  }

  return null;
}
