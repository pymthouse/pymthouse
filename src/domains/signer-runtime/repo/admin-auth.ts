import { eq } from "drizzle-orm";
import { db } from "@/db/index";
import { users } from "@/db/schema";

export async function getUserById(id: string) {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return rows[0] ?? null;
}
