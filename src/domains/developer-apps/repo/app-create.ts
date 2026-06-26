import { db } from "@/db/index";
import { developerApps } from "@/db/schema";

export async function createDeveloperAppRecord(record: typeof developerApps.$inferInsert) {
  await db.insert(developerApps).values(record);
}
