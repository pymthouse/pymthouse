import { and, eq } from "drizzle-orm";
import { db } from "@/db/index";
import { endUsers } from "@/db/schema";

export async function getAppEndUser(appId: string, externalUserId: string) {
  const rows = await db
    .select()
    .from(endUsers)
    .where(
      and(
        eq(endUsers.appId, appId),
        eq(endUsers.externalUserId, externalUserId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function createAppEndUser(params: {
  id: string;
  appId: string;
  externalUserId: string;
}) {
  await db.insert(endUsers).values({
    id: params.id,
    appId: params.appId,
    externalUserId: params.externalUserId,
    creditBalanceWei: "0",
  });
}
