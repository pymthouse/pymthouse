/**
 * Membership on the singleton platform default app, matching
 * mintDefaultAppNetworkKey: externalUserId is the PymtHouse user id.
 */

import { v4 as uuidv4 } from "uuid";

import { db } from "@/db/index";
import { appUsers } from "@/db/schema";
import { provisionAppUserBilling } from "@/lib/billing/provision-app-user";
import {
  ensurePlatformDefaultApp,
  getPlatformDefaultApp,
} from "@/lib/platform-default-app";

export type PlatformDefaultAppUser = {
  clientId: string;
  developerAppId: string;
  externalUserId: string;
  appUserId: string;
};

export async function ensurePlatformDefaultAppUser(input: {
  userId: string;
  email?: string | null;
}): Promise<PlatformDefaultAppUser> {
  await ensurePlatformDefaultApp();
  const platform = await getPlatformDefaultApp();
  if (!platform) {
    throw new Error("Platform default app is missing");
  }
  const clientId = platform.clientId;
  const developerAppId = platform.app.id;
  const externalUserId = input.userId;
  const now = new Date().toISOString();

  const newUser = {
    id: uuidv4(),
    clientId: developerAppId,
    externalUserId,
    email: input.email?.trim() || null,
    status: "active",
    role: "user",
    createdAt: now,
  };

  const upserted = await db
    .insert(appUsers)
    .values(newUser)
    .onConflictDoUpdate({
      target: [appUsers.clientId, appUsers.externalUserId],
      set: {
        status: "active",
        role: "user",
        ...(input.email != null ? { email: input.email.trim() || null } : {}),
      },
    })
    .returning();
  const appUser = upserted[0] ?? newUser;

  try {
    await provisionAppUserBilling({
      clientId: developerAppId,
      externalUserId,
    });
  } catch (err) {
    console.error("Platform default app user billing provision failed:", err);
  }

  return {
    clientId,
    developerAppId,
    externalUserId,
    appUserId: appUser.id,
  };
}
