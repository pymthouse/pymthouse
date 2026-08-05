import { eq } from "drizzle-orm";

import { db } from "@/db/index";
import { platformBillingSettings } from "@/db/schema";
import { OWNER_STARTER_PLAN_NAME } from "@/lib/openmeter/owner-starter-key";
import { defaultStarterIncludedUsdMicros } from "@/lib/starter-default-plan-display";

/** Fixed primary key for the singleton platform billing settings row. */
export const PLATFORM_BILLING_SETTINGS_ID = "default";

export const OWNER_STARTER_PLAN_NAME_MAX_LEN = 80;

export type PlatformOwnerStarterSource = "db" | "env" | "fallback";

export type ResolvedPlatformOwnerStarterDefault = {
  ownerStarterIncludedUsdMicros: string;
  /** Display / OpenMeter plan name (never empty). */
  ownerStarterPlanName: string;
  source: PlatformOwnerStarterSource;
  updatedBy: string | null;
  updatedAt: string | null;
};

function normalizeMicros(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Normalize a Starter plan display name. Empty / missing → default constant.
 * @internal Exported for unit tests.
 */
export function normalizeOwnerStarterPlanName(
  raw: string | null | undefined,
): string {
  const trimmed = raw?.trim().replaceAll(/\s+/g, " ") ?? "";
  if (!trimmed) return OWNER_STARTER_PLAN_NAME;
  if (trimmed.length > OWNER_STARTER_PLAN_NAME_MAX_LEN) {
    throw new Error(
      `ownerStarterPlanName must be at most ${OWNER_STARTER_PLAN_NAME_MAX_LEN} characters`,
    );
  }
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
 * Resolve the platform Owner Starter included allowance + display name.
 *
 * Precedence for micros: DB singleton → env → hardcoded `$5` (`5000000`).
 * Name: DB when set → `OWNER_STARTER_PLAN_NAME`.
 * App/M2M Starter seed continues to use `defaultStarterIncludedUsdMicros()` only.
 */
export async function resolvePlatformOwnerStarterDefault(): Promise<ResolvedPlatformOwnerStarterDefault> {
  const rows = await db
    .select({
      ownerStarterIncludedUsdMicros:
        platformBillingSettings.ownerStarterIncludedUsdMicros,
      ownerStarterPlanName: platformBillingSettings.ownerStarterPlanName,
      updatedBy: platformBillingSettings.updatedBy,
      updatedAt: platformBillingSettings.updatedAt,
    })
    .from(platformBillingSettings)
    .where(eq(platformBillingSettings.id, PLATFORM_BILLING_SETTINGS_ID))
    .limit(1);

  const row = rows[0];
  const planName = normalizeOwnerStarterPlanName(row?.ownerStarterPlanName);
  const fromDb = normalizeMicros(row?.ownerStarterIncludedUsdMicros);
  if (fromDb) {
    return {
      ownerStarterIncludedUsdMicros: fromDb,
      ownerStarterPlanName: planName,
      source: "db",
      updatedBy: row?.updatedBy ?? null,
      updatedAt: row?.updatedAt ?? null,
    };
  }

  const { micros, source } = envOrFallbackSource();
  return {
    ownerStarterIncludedUsdMicros: micros,
    ownerStarterPlanName: planName,
    source,
    updatedBy: null,
    updatedAt: null,
  };
}

/** Convenience: micros string only. */
export async function resolvePlatformOwnerStarterIncludedUsdMicros(): Promise<string> {
  return (await resolvePlatformOwnerStarterDefault()).ownerStarterIncludedUsdMicros;
}

/** Convenience: display / OpenMeter name only. */
export async function resolvePlatformOwnerStarterPlanName(): Promise<string> {
  return (await resolvePlatformOwnerStarterDefault()).ownerStarterPlanName;
}

/** Upsert the singleton Owner Starter platform default. */
export async function setPlatformOwnerStarterIncludedUsdMicros(input: {
  ownerStarterIncludedUsdMicros: string;
  /** When omitted, keep the existing DB name (or default on first insert). */
  ownerStarterPlanName?: string;
  updatedBy: string;
}): Promise<ResolvedPlatformOwnerStarterDefault> {
  const micros = normalizeMicros(input.ownerStarterIncludedUsdMicros);
  if (!micros) {
    throw new Error("ownerStarterIncludedUsdMicros must be a non-negative integer string");
  }
  const updatedBy = input.updatedBy.trim() || null;
  const now = new Date().toISOString();

  let planName: string;
  if (input.ownerStarterPlanName !== undefined) {
    planName = normalizeOwnerStarterPlanName(input.ownerStarterPlanName);
  } else {
    const existing = await resolvePlatformOwnerStarterDefault();
    planName = existing.ownerStarterPlanName;
  }

  await db
    .insert(platformBillingSettings)
    .values({
      id: PLATFORM_BILLING_SETTINGS_ID,
      ownerStarterIncludedUsdMicros: micros,
      ownerStarterPlanName: planName,
      updatedBy,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: platformBillingSettings.id,
      set: {
        ownerStarterIncludedUsdMicros: micros,
        ownerStarterPlanName: planName,
        updatedBy,
        updatedAt: now,
      },
    });

  return {
    ownerStarterIncludedUsdMicros: micros,
    ownerStarterPlanName: planName,
    source: "db",
    updatedBy,
    updatedAt: now,
  };
}
