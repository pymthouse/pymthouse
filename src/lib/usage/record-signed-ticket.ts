import { v4 as uuidv4 } from "uuid";
import { db } from "@/db/index";
import { appUsers } from "@/db/schema";

export async function resolveOrCreateAppUser(input: {
  clientId: string;
  externalUserId: string;
}): Promise<{ id: string; externalUserId: string }> {
  const externalUserId = input.externalUserId.trim();
  const newUser = {
    id: uuidv4(),
    clientId: input.clientId,
    externalUserId,
    email: null,
    status: "active",
    role: "user",
    createdAt: new Date().toISOString(),
  };

  const upserted = await db
    .insert(appUsers)
    .values(newUser)
    .onConflictDoUpdate({
      target: [appUsers.clientId, appUsers.externalUserId],
      set: { role: "user" },
    })
    .returning();

  const row = upserted[0] ?? newUser;
  return { id: row.id, externalUserId: row.externalUserId };
}
