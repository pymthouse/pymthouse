import { eq } from "drizzle-orm";

import { db } from "@/db/index";
import { platformBillingSettings } from "@/db/schema";
import { defaultStarterIncludedUsdMicros } from "@/lib/starter-default-plan-display";

/** Fixed primary key for the singleton platform billing settings row. */
export const PLATFORM_BILLING_SETTINGS_ID = "default";

export type PlatformOwnerStarterSource = "db" | "env" | "fallback";

export type ResolvedPlatformOwnerStarterDefault = {
  ownerStarterIncludedUsdMicros: string;
  source: PlatformOwnerStarterSource;
  updatedBy: string | null;
  updatedAt: string | null;
};

function normalizeMicros(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return null;
  return trimmed;
}

function envOrFallbackSource(): {
  micros: string;
  source: Exclude<PlatformOwnerStarterSource, "db">;
} {
  const fromEnv = process.env.OPENMETER_DEFAULT_STARTER_INCLUDED_USD_MICROS?.trim();
  if (fromEnv && /^\d+$/.test(fromEnv)) {
    return { micros: fromEnv, source: "env" };
  }
  return { micros: defaultStarterIncludedUsdMicros(), source: "fallback" };
}

/**
 * Resolve the platform Owner Starter included allowance.
 *
 * Precedence: DB singleton → env → hardcoded `$5` (`5000000`).
 * App/M2M Starter seed continues to use `defaultStarterIncludedUsdMicros()` only.
 */
export async function resolvePlatformOwnerStarterDefault(): Promise<ResolvedPlatformOwnerStarterDefault> {
  const rows = await db
    .select({
      ownerStarterIncludedUsdMicros:
        platformBillingSettings.ownerStarterIncludedUsdMicros,
      updatedBy: platformBillingSettings.updatedBy,
      updatedAt: platformBillingSettings.updatedAt,
    })
    .from(platformBillingSettings)
    .where(eq(platformBillingSettings.id, PLATFORM_BILLING_SETTINGS_ID))
    .limit(1);

  const row = rows[0];
  const fromDb = normalizeMicros(row?.ownerStarterIncludedUsdMicros);
  if (fromDb) {
    return {
      ownerStarterIncludedUsdMicros: fromDb,
      source: "db",
      updatedBy: row?.updatedBy ?? null,
      updatedAt: row?.updatedAt ?? null,
    };
  }

  const { micros, source } = envOrFallbackSource();
  return {
    ownerStarterIncludedUsdMicros: micros,
    source,
    updatedBy: null,
    updatedAt: null,
  };
}

/** Convenience: micros string only. */
export async function resolvePlatformOwnerStarterIncludedUsdMicros(): Promise<string> {
  return (await resolvePlatformOwnerStarterDefault()).ownerStarterIncludedUsdMicros;
}

/** Upsert the singleton Owner Starter platform default. */
export async function setPlatformOwnerStarterIncludedUsdMicros(input: {
  ownerStarterIncludedUsdMicros: string;
  updatedBy: string;
}): Promise<ResolvedPlatformOwnerStarterDefault> {
  const micros = normalizeMicros(input.ownerStarterIncludedUsdMicros);
  if (!micros) {
    throw new Error("ownerStarterIncludedUsdMicros must be a non-negative integer string");
  }
  const now = new Date().toISOString();
  const existing = await db
    .select({ id: platformBillingSettings.id })
    .from(platformBillingSettings)
    .where(eq(platformBillingSettings.id, PLATFORM_BILLING_SETTINGS_ID))
    .limit(1);

  if (existing[0]?.id) {
    await db
      .update(platformBillingSettings)
      .set({
        ownerStarterIncludedUsdMicros: micros,
        updatedBy: input.updatedBy,
        updatedAt: now,
      })
      .where(eq(platformBillingSettings.id, PLATFORM_BILLING_SETTINGS_ID));
  } else {
    await db.insert(platformBillingSettings).values({
      id: PLATFORM_BILLING_SETTINGS_ID,
      ownerStarterIncludedUsdMicros: micros,
      updatedBy: input.updatedBy,
      updatedAt: now,
    });
  }

  return {
    ownerStarterIncludedUsdMicros: micros,
    source: "db",
    updatedBy: input.updatedBy,
    updatedAt: now,
  };
}
