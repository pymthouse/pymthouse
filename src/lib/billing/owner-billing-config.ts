import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";

import { db } from "@/db/index";
import { ownerBillingConfig } from "@/db/schema";
import {
  platformDefaultApplicationFeeBps,
  platformDefaultEndUserCap,
} from "@/lib/billing/platform-billing-defaults";
import { defaultStarterIncludedUsdMicros } from "@/lib/starter-default-plan-display";

/**
 * Per-owner cost-rail overrides.
 *
 * The cost rail is account-level — a developer subscribes to PymtHouse once and
 * every app they own bills against it — so these values live per owner, not per
 * app, and are admin-set. A missing row (the common case) means platform
 * defaults. See docs/adr-owner-vs-app-billing.md.
 */

export type OwnerBillingOverrides = {
  starterIncludedUsdMicros: string | null;
  endUserCap: number | null;
  applicationFeeBps: number | null;
  note: string | null;
};

export type ResolvedOwnerBilling = {
  starterIncludedUsdMicros: string;
  endUserCap: number;
  applicationFeeBps: number;
  /** True when any value came from an override rather than a platform default. */
  hasOverride: boolean;
  note: string | null;
};

function normalizeMicros(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return null;
  return trimmed;
}

export async function getOwnerBillingOverrides(
  ownerUserId: string,
): Promise<OwnerBillingOverrides | null> {
  const id = ownerUserId.trim();
  if (!id) return null;
  const rows = await db
    .select({
      starterIncludedUsdMicros: ownerBillingConfig.starterIncludedUsdMicros,
      endUserCap: ownerBillingConfig.endUserCap,
      applicationFeeBps: ownerBillingConfig.applicationFeeBps,
      note: ownerBillingConfig.note,
    })
    .from(ownerBillingConfig)
    .where(eq(ownerBillingConfig.ownerUserId, id))
    .limit(1);
  return rows[0] ?? null;
}

/** Merge overrides onto platform defaults. Pure, so the precedence is testable. */
export function mergeOwnerBilling(
  overrides: OwnerBillingOverrides | null,
  defaults: {
    starterIncludedUsdMicros: string;
    endUserCap: number;
    applicationFeeBps: number;
  },
): ResolvedOwnerBilling {
  const starter = normalizeMicros(overrides?.starterIncludedUsdMicros);
  const cap =
    typeof overrides?.endUserCap === "number" && overrides.endUserCap > 0
      ? overrides.endUserCap
      : null;
  const fee =
    typeof overrides?.applicationFeeBps === "number" &&
    overrides.applicationFeeBps >= 0
      ? overrides.applicationFeeBps
      : null;

  return {
    starterIncludedUsdMicros: starter ?? defaults.starterIncludedUsdMicros,
    endUserCap: cap ?? defaults.endUserCap,
    applicationFeeBps: fee ?? defaults.applicationFeeBps,
    hasOverride: starter !== null || cap !== null || fee !== null,
    note: overrides?.note ?? null,
  };
}

/** Effective cost-rail settings for one owner. */
export async function resolveOwnerBilling(
  ownerUserId: string,
): Promise<ResolvedOwnerBilling> {
  const overrides = await getOwnerBillingOverrides(ownerUserId);
  return mergeOwnerBilling(overrides, {
    starterIncludedUsdMicros: defaultStarterIncludedUsdMicros(),
    endUserCap: platformDefaultEndUserCap(),
    applicationFeeBps: platformDefaultApplicationFeeBps(),
  });
}

/**
 * Included allowance for one owner's Starter plan.
 *
 * Callers that also need the OpenMeter plan must use the *same* value when
 * resolving the plan key — a local override that is not reflected in the plan
 * would show an allowance OpenMeter will not honour when invoicing.
 */
export async function resolveOwnerStarterIncludedUsdMicros(
  ownerUserId: string,
): Promise<string> {
  return (await resolveOwnerBilling(ownerUserId)).starterIncludedUsdMicros;
}

/** Upsert an owner's overrides. Admin-only at the route layer. */
export async function setOwnerBillingOverrides(input: {
  ownerUserId: string;
  starterIncludedUsdMicros?: string | null;
  endUserCap?: number | null;
  applicationFeeBps?: number | null;
  note?: string | null;
  updatedBy: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const values = {
    starterIncludedUsdMicros: normalizeMicros(input.starterIncludedUsdMicros),
    endUserCap: input.endUserCap ?? null,
    applicationFeeBps: input.applicationFeeBps ?? null,
    note: input.note?.trim() || null,
    updatedBy: input.updatedBy,
    updatedAt: now,
  };

  const existing = await db
    .select({ id: ownerBillingConfig.id })
    .from(ownerBillingConfig)
    .where(eq(ownerBillingConfig.ownerUserId, input.ownerUserId))
    .limit(1);

  if (existing[0]?.id) {
    await db
      .update(ownerBillingConfig)
      .set(values)
      .where(eq(ownerBillingConfig.ownerUserId, input.ownerUserId));
    return;
  }
  await db.insert(ownerBillingConfig).values({
    id: uuidv4(),
    ownerUserId: input.ownerUserId,
    createdAt: now,
    ...values,
  });
}
