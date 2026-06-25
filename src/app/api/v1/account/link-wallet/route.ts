import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/next-auth-options";
import { db } from "@/db/index";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { verifyTurnkeySessionJwt } from "@/lib/turnkey";
import {
  assertDeveloperWalletBindingAvailable,
  resolveAttestedWalletAddress,
  WalletBindingConflictError,
} from "@/lib/turnkey/attest-wallet";

/**
 * POST /api/v1/account/link-wallet
 *
 * Links a Turnkey wallet to the currently authenticated user. Intended for
 * users who signed up via GitHub OAuth (which doesn't provision a Turnkey
 * wallet) and need to complete wallet setup before accessing the dashboard.
 */
export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sessionUser = session.user as Record<string, unknown>;
  const userId = sessionUser.id as string | undefined;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as {
    turnkeySessionJwt?: string;
    walletAddress?: string;
  };

  if (!body.turnkeySessionJwt) {
    return NextResponse.json(
      { error: "Missing turnkeySessionJwt" },
      { status: 400 },
    );
  }

  const claims = await verifyTurnkeySessionJwt(body.turnkeySessionJwt);
  if (!claims) {
    return NextResponse.json(
      { error: "Invalid or expired Turnkey session" },
      { status: 401 },
    );
  }

  // Prevent linking a Turnkey user that is already tied to a different account.
  const conflict = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.turnkeyUserId, claims.userId))
    .limit(1);

  if (conflict[0] && conflict[0].id !== userId) {
    return NextResponse.json(
      { error: "This Turnkey wallet is already linked to another account." },
      { status: 409 },
    );
  }

  let walletAddress: string | null;
  try {
    const resolved = await resolveAttestedWalletAddress({
      organizationId: claims.organizationId,
      clientHint: body.walletAddress,
    });
    walletAddress = resolved.walletAddress;
    await assertDeveloperWalletBindingAvailable({
      walletAddress,
      turnkeyUserId: claims.userId,
      excludeUserId: userId,
    });
  } catch (err) {
    if (err instanceof WalletBindingConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }

  await db
    .update(users)
    .set({
      walletAddress,
      turnkeyUserId: claims.userId,
      turnkeySubOrgId: claims.organizationId,
    })
    .where(eq(users.id, userId));

  return NextResponse.json({ ok: true });
}
