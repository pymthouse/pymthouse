import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { db } from "@/db/index";
import { users } from "@/db/schema";
import { canPurgeAccountRow, purgeEmptyAccountUser } from "@/lib/account-deletion";
import { test } from "@/test-utils/db-guard";
import { createTestUser, deleteTestUser } from "@/test-utils/fixtures";

test("purgeEmptyAccountUser deletes a row that owns no apps", async (t) => {
  const userId = await createTestUser();
  t.after(async () => {
    await deleteTestUser(userId).catch(() => undefined);
  });

  assert.equal(canPurgeAccountRow(false), true);
  await purgeEmptyAccountUser(userId);

  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  assert.equal(rows.length, 0);
});
