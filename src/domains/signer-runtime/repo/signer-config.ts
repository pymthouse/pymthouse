import { eq } from "drizzle-orm";
import { db } from "@/db/index";
import { signerConfig } from "@/db/schema";

export async function getDefaultSignerConfig() {
  const rows = await db.select().from(signerConfig).where(eq(signerConfig.id, "default")).limit(1);
  return rows[0] ?? null;
}

export async function updateDefaultSignerConfig(updates: Record<string, unknown>) {
  await db.update(signerConfig).set(updates).where(eq(signerConfig.id, "default"));
}
