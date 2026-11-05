import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db/index";
import { users } from "@/db/schema";

export async function getUserById(userId: string) {
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return rows[0] ?? null;
}

export async function getUserByTurnkeyUserId(turnkeyUserId: string) {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.turnkeyUserId, turnkeyUserId))
    .limit(1);
  return rows[0] ?? null;
}

export async function updateUserWalletAddress(userId: string, walletAddress: string) {
  await db.update(users).set({ walletAddress }).where(eq(users.id, userId));
}

export async function createDeveloperUser(params: {
  id: string;
  turnkeyUserId: string;
  email: string;
  name: string | null;
  walletAddress: string | null;
}) {
  await db.insert(users).values({
    id: params.id,
    email: params.email,
    name: params.name,
    oauthProvider: "turnkey-wallet",
    oauthSubject: params.turnkeyUserId,
    role: "developer",
    walletAddress: params.walletAddress,
    turnkeyUserId: params.turnkeyUserId,
  });
}

export async function getAdminUserByNormalizedEmail(email: string) {
  const rows = await db
    .select()
    .from(users)
    .where(
      and(
        eq(users.role, "admin"),
        sql`lower(${users.email}) = ${email.trim().toLowerCase()}`,
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
