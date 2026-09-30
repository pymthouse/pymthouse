import { desc, eq } from "drizzle-orm";
import { db } from "@/db/index";
import { oidcSigningKeys } from "@/db/schema";

export async function insertSigningKey(params: {
  id: string;
  kid: string;
  algorithm: string;
  publicKeyPem: string;
  privateKeyPem: string;
  active: number;
}) {
  await db.insert(oidcSigningKeys).values(params);
}

export async function deactivateActiveSigningKeys(rotatedAt: string) {
  await db
    .update(oidcSigningKeys)
    .set({ active: 0, rotatedAt })
    .where(eq(oidcSigningKeys.active, 1));
}

export async function getActiveSigningKeyRow() {
  const rows = await db
    .select()
    .from(oidcSigningKeys)
    .where(eq(oidcSigningKeys.active, 1))
    .orderBy(desc(oidcSigningKeys.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function listRecentSigningKeyRows(limit: number) {
  return db.select().from(oidcSigningKeys).orderBy(desc(oidcSigningKeys.createdAt)).limit(limit);
}

export async function getSigningKeyRowByKid(kid: string) {
  const rows = await db
    .select()
    .from(oidcSigningKeys)
    .where(eq(oidcSigningKeys.kid, kid))
    .limit(1);
  return rows[0] ?? null;
}
