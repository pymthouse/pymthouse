import { eq } from "drizzle-orm";

import { db } from "@/db/index";
import { users } from "@/db/schema";
import {
  verifyTurnkeySessionJwt,
  type TurnkeySessionClaims,
} from "@/lib/turnkey";

export type AccountSessionBindingResult =
  | { ok: true }
  | {
      ok: false;
      status: 401 | 403 | 409;
      error: string;
    };

type AccountSessionBindingDeps = {
  verifySessionJwt(sessionJwt: string): Promise<TurnkeySessionClaims | null>;
  loadTurnkeyUserId(userId: string): Promise<string | null>;
};

const defaultDeps: AccountSessionBindingDeps = {
  verifySessionJwt: verifyTurnkeySessionJwt,
  async loadTurnkeyUserId(userId) {
    const rows = await db
      .select({ turnkeyUserId: users.turnkeyUserId })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return rows[0]?.turnkeyUserId?.trim() || null;
  },
};

/**
 * Bind a live Turnkey session to the authenticated PymtHouse row.
 *
 * Matching on Turnkey user id—not email—keeps duplicate-email migration
 * accounts separate and lets email OTP open the exact old sub-organization
 * represented by its existing PymtHouse row.
 */
export async function verifyAccountSessionBinding(
  input: {
    userId: string;
    turnkeySessionJwt: string;
  },
  deps: AccountSessionBindingDeps = defaultDeps,
): Promise<AccountSessionBindingResult> {
  const userId = input.userId.trim();
  const sessionJwt = input.turnkeySessionJwt.trim();
  if (!userId || !sessionJwt) {
    return {
      ok: false,
      status: 401,
      error: "A live Turnkey session is required.",
    };
  }

  const claims = await deps.verifySessionJwt(sessionJwt);
  if (!claims) {
    return {
      ok: false,
      status: 401,
      error: "The Turnkey session is invalid or expired.",
    };
  }

  const expectedTurnkeyUserId = await deps.loadTurnkeyUserId(userId);
  if (!expectedTurnkeyUserId) {
    return {
      ok: false,
      status: 403,
      error: "This PymtHouse account is not linked to a Turnkey user.",
    };
  }

  if (claims.userId !== expectedTurnkeyUserId) {
    return {
      ok: false,
      status: 409,
      error:
        "The active wallet belongs to a different PymtHouse account. Sign out, then sign in again with the account you want to manage.",
    };
  }

  return { ok: true };
}
