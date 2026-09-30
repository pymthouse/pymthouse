import { eq } from "drizzle-orm";
import { db } from "@/db/index";
import { endUsers, users } from "@/db/schema";

export async function getUserBySubject(sub: string) {
  const rows = await db.select().from(users).where(eq(users.id, sub)).limit(1);
  return rows[0] ?? null;
}

export async function getEndUserBySubject(sub: string) {
  const rows = await db.select().from(endUsers).where(eq(endUsers.id, sub)).limit(1);
  return rows[0] ?? null;
}
