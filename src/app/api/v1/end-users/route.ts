import { NextRequest, NextResponse } from "next/server";
import { getAdminUser } from "@/domains/identity-access/runtime/admin-auth";
import {
  createAdminEndUser,
  findOrCreateEndUserFromTurnkeySession,
  getEndUserForTurnkeySession,
  listAdminEndUsers,
  updateEndUserCredits,
} from "@/domains/end-user-accounts/runtime/end-users";

/**
 * GET /api/v1/end-users -- List end users (admin auth) or get current end user (Turnkey session JWT)
 */
export async function GET(request: NextRequest) {
  const adminUser = await getAdminUser(request);
  if (adminUser) {
    const allEndUsers = await listAdminEndUsers();
    return NextResponse.json({ endUsers: allEndUsers });
  }

  const turnkeyJwt = getTurnkeySessionJwtFromRequest(request);
  if (turnkeyJwt) {
    const result = await getEndUserForTurnkeySession(turnkeyJwt);
    return NextResponse.json(result.body, { status: result.status });
  }

  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

/**
 * POST /api/v1/end-users -- Register a new end user (Turnkey session JWT) or create one (admin auth)
 */
export async function POST(request: NextRequest) {
  const body = await request.json();

  // Admin creating an end user manually
  const adminUser = await getAdminUser(request);
  if (adminUser) {
    const created = await createAdminEndUser(body);
    return NextResponse.json(created.body, { status: created.status });
  }

  const turnkeyJwtPost = getTurnkeySessionJwtFromRequest(request);
  if (turnkeyJwtPost) {
    const result = await findOrCreateEndUserFromTurnkeySession(
      turnkeyJwtPost,
      typeof body.walletAddress === "string" ? body.walletAddress : undefined,
    );
    return NextResponse.json(result.body, { status: result.status });
  }

  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

/**
 * PATCH /api/v1/end-users -- Update end user credits (admin auth)
 */
export async function PATCH(request: NextRequest) {
  const adminUser = await getAdminUser(request);
  if (!adminUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const result = await updateEndUserCredits({
    endUserId: String(body.id || ""),
    action: String(body.action || ""),
    amountWei: String(body.amountWei || ""),
  });
  return NextResponse.json(result.body, { status: result.status });
}

/** Turnkey session JWT from `x-turnkey-session` or `Authorization: Bearer`. */
function getTurnkeySessionJwtFromRequest(request: NextRequest): string | null {
  const header = request.headers.get("x-turnkey-session")?.trim();
  if (header) return header;

  const auth = request.headers.get("authorization")?.trim();
  if (auth?.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim() || null;
  }

  return null;
}
