import { eq } from "drizzle-orm";

import { db } from "@/db/index";
import { developerApps, users } from "@/db/schema";
import {
  fundedOwnerBlocksReassign,
  ownerHasPrepaidCredits,
} from "@/lib/account-deletion";
import { getOwnerPrepaidCreditBalance } from "@/lib/openmeter/credit-allowance-summary";
import { isPlatformDefaultAppRow } from "@/lib/platform-default-app";
import {
  ensureProviderAdminMembership,
  getProviderApp,
} from "@/lib/provider-apps";

export type ReassignAppOwnerResult =
  | { ok: true; ownerId: string }
  | { ok: false; status: 400 | 404; error: string };

export async function reassignAppOwner(input: {
  appId: string;
  newOwnerUserId: string;
}): Promise<ReassignAppOwnerResult> {
  const newOwnerUserId = input.newOwnerUserId.trim();
  if (!newOwnerUserId) {
    return { ok: false, status: 400, error: "newOwnerUserId is required" };
  }

  const app = await getProviderApp(input.appId);
  if (!app) {
    return { ok: false, status: 404, error: "App not found" };
  }
  if (isPlatformDefaultAppRow(app)) {
    return {
      ok: false,
      status: 400,
      error: "The platform default app cannot be reassigned.",
    };
  }

  const ownerRows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, newOwnerUserId))
    .limit(1);
  if (!ownerRows[0]) {
    return { ok: false, status: 404, error: "User not found" };
  }

  if (app.ownerId === newOwnerUserId) {
    return { ok: true, ownerId: newOwnerUserId };
  }

  const balance = await getOwnerPrepaidCreditBalance(app.ownerId).catch(() => null);
  if (fundedOwnerBlocksReassign(ownerHasPrepaidCredits(balance))) {
    return {
      ok: false,
      status: 400,
      error:
        "Current owner has prepaid credits. Reassigning owner would strand those credits. Remap login onto the owning row instead.",
    };
  }

  await db
    .update(developerApps)
    .set({
      ownerId: newOwnerUserId,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(developerApps.id, app.id));
  await ensureProviderAdminMembership(newOwnerUserId, app.id);
  return { ok: true, ownerId: newOwnerUserId };
}
