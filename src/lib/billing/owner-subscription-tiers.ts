import { asc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "@/db/index";
import { ownerSubscriptionTiers } from "@/db/schema";
import { defaultRetailRateUsd } from "@/lib/plan-pricing";
import {
  isValidOwnerPaidTierKey,
  OWNER_PAID_PLAN_KEY,
} from "@/lib/openmeter/owner-paid-key";

export type OwnerSubscriptionTierRow = typeof ownerSubscriptionTiers.$inferSelect;

export type OwnerSubscriptionTierPublic = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  monthlyFeeUsd: string;
  includedUsdMicros: string;
  overageRateUsd: string | null;
  sortOrder: number;
  active: boolean;
  openmeterPlanId: string | null;
  openmeterPlanVersion: number | null;
  lastSyncedAt: string | null;
};

export function toOwnerSubscriptionTierPublic(
  row: OwnerSubscriptionTierRow,
): OwnerSubscriptionTierPublic {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    monthlyFeeUsd: row.monthlyFeeUsd,
    includedUsdMicros: row.includedUsdMicros,
    overageRateUsd: row.overageRateUsd,
    sortOrder: row.sortOrder,
    active: row.active === 1,
    openmeterPlanId: row.openmeterPlanId,
    openmeterPlanVersion: row.openmeterPlanVersion,
    lastSyncedAt: row.lastSyncedAt,
  };
}

/** Parse a positive USD decimal amount for flat fees (e.g. "20.00"). */
export function parseOwnerTierMonthlyFeeUsd(raw: unknown): string | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return raw.toFixed(2);
  }
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n.toFixed(2);
}

export function parseOwnerTierIncludedMicros(raw: unknown): string | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return String(Math.floor(raw));
  }
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Parse an optional custom overage rate. Empty/null → platform default (null).
 * Rejects zero, negative, and malformed values.
 */
export function parseOwnerTierOverageRateUsd(
  raw: unknown,
): { ok: true; value: string | null } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return { ok: false };
    return { ok: true, value: String(raw) };
  }
  if (typeof raw !== "string") return { ok: false };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };
  if (!/^\d+(\.\d+)?$/.test(trimmed) || Number(trimmed) <= 0) {
    return { ok: false };
  }
  return { ok: true, value: trimmed };
}

export function resolveOwnerTierOverageRateUsd(
  overageRateUsd: string | null | undefined,
): string {
  const parsed = parseOwnerTierOverageRateUsd(overageRateUsd);
  if (parsed.ok && parsed.value) return parsed.value;
  return defaultRetailRateUsd();
}

export async function listOwnerSubscriptionTiers(input?: {
  activeOnly?: boolean;
}): Promise<OwnerSubscriptionTierRow[]> {
  const rows = await db
    .select()
    .from(ownerSubscriptionTiers)
    .orderBy(asc(ownerSubscriptionTiers.sortOrder), asc(ownerSubscriptionTiers.name));
  if (input?.activeOnly) {
    return rows.filter((row) => row.active === 1);
  }
  return rows;
}

export async function listSelectableOwnerSubscriptionTiers(): Promise<
  OwnerSubscriptionTierRow[]
> {
  const rows = await listOwnerSubscriptionTiers({ activeOnly: true });
  return rows.filter(
    (row) => parseOwnerTierMonthlyFeeUsd(row.monthlyFeeUsd) != null,
  );
}

export async function getOwnerSubscriptionTierByKey(
  planKey: string,
): Promise<OwnerSubscriptionTierRow | null> {
  const key = planKey.trim();
  if (!key) return null;
  const rows = await db
    .select()
    .from(ownerSubscriptionTiers)
    .where(eq(ownerSubscriptionTiers.key, key))
    .limit(1);
  return rows[0] ?? null;
}

export async function getOwnerSubscriptionTierById(
  id: string,
): Promise<OwnerSubscriptionTierRow | null> {
  const rows = await db
    .select()
    .from(ownerSubscriptionTiers)
    .where(eq(ownerSubscriptionTiers.id, id.trim()))
    .limit(1);
  return rows[0] ?? null;
}

export type CreateOwnerSubscriptionTierInput = {
  key: string;
  name: string;
  description?: string | null;
  monthlyFeeUsd: string;
  includedUsdMicros: string;
  overageRateUsd?: string | null;
  sortOrder?: number;
  active?: boolean;
};

export async function createOwnerSubscriptionTier(
  input: CreateOwnerSubscriptionTierInput,
): Promise<OwnerSubscriptionTierRow> {
  const key = input.key.trim().toLowerCase();
  if (!isValidOwnerPaidTierKey(key)) {
    throw new Error(
      "key must be pymthouse_owner_paid or pymthouse_owner_paid_<slug>",
    );
  }
  const monthlyFeeUsd = parseOwnerTierMonthlyFeeUsd(input.monthlyFeeUsd);
  if (!monthlyFeeUsd) {
    throw new Error("monthlyFeeUsd must be a positive USD amount");
  }
  const includedUsdMicros = parseOwnerTierIncludedMicros(input.includedUsdMicros);
  if (includedUsdMicros == null) {
    throw new Error("includedUsdMicros must be a non-negative integer string");
  }
  const overageParsed = parseOwnerTierOverageRateUsd(input.overageRateUsd);
  if (!overageParsed.ok) {
    throw new Error("overageRateUsd must be a positive USD amount or empty");
  }
  const now = new Date().toISOString();
  const existing = await getOwnerSubscriptionTierByKey(key);
  if (existing) {
    throw new Error(
      `Tier key "${key}" already exists — edit that tier’s fee/allowance instead of creating again`,
    );
  }
  const row = {
    id: randomUUID(),
    key,
    name: input.name.trim() || key,
    description: input.description?.trim() || null,
    monthlyFeeUsd,
    includedUsdMicros,
    overageRateUsd: overageParsed.value,
    sortOrder: input.sortOrder ?? 0,
    active: input.active === false ? 0 : 1,
    openmeterPlanId: null,
    openmeterPlanVersion: null,
    lastSyncedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(ownerSubscriptionTiers).values(row);
  return row;
}

export type UpdateOwnerSubscriptionTierInput = {
  name?: string;
  description?: string | null;
  monthlyFeeUsd?: string;
  includedUsdMicros?: string;
  overageRateUsd?: string | null;
  sortOrder?: number;
  active?: boolean;
};

function patchOwnerTierName(
  patch: Partial<OwnerSubscriptionTierRow>,
  name: string,
): void {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("name is required");
  patch.name = trimmed;
}

function patchOwnerTierMonthlyFee(
  patch: Partial<OwnerSubscriptionTierRow>,
  raw: string,
): void {
  const monthlyFeeUsd = parseOwnerTierMonthlyFeeUsd(raw);
  if (!monthlyFeeUsd) {
    throw new Error("monthlyFeeUsd must be a positive USD amount");
  }
  patch.monthlyFeeUsd = monthlyFeeUsd;
}

function patchOwnerTierIncluded(
  patch: Partial<OwnerSubscriptionTierRow>,
  raw: string,
): void {
  const includedUsdMicros = parseOwnerTierIncludedMicros(raw);
  if (includedUsdMicros == null) {
    throw new Error("includedUsdMicros must be a non-negative integer string");
  }
  patch.includedUsdMicros = includedUsdMicros;
}

function patchOwnerTierOverage(
  patch: Partial<OwnerSubscriptionTierRow>,
  raw: string | null,
): void {
  const overageParsed = parseOwnerTierOverageRateUsd(raw);
  if (!overageParsed.ok) {
    throw new Error("overageRateUsd must be a positive USD amount or empty");
  }
  patch.overageRateUsd = overageParsed.value;
}

function applyOwnerTierUpdatePatch(
  input: UpdateOwnerSubscriptionTierInput,
): Partial<OwnerSubscriptionTierRow> {
  const patch: Partial<OwnerSubscriptionTierRow> = {
    updatedAt: new Date().toISOString(),
  };
  if (input.name !== undefined) patchOwnerTierName(patch, input.name);
  if (input.description !== undefined) {
    patch.description = input.description?.trim() || null;
  }
  if (input.monthlyFeeUsd !== undefined) {
    patchOwnerTierMonthlyFee(patch, input.monthlyFeeUsd);
  }
  if (input.includedUsdMicros !== undefined) {
    patchOwnerTierIncluded(patch, input.includedUsdMicros);
  }
  if (input.overageRateUsd !== undefined) {
    patchOwnerTierOverage(patch, input.overageRateUsd);
  }
  if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
  if (input.active !== undefined) patch.active = input.active ? 1 : 0;
  return patch;
}

export async function updateOwnerSubscriptionTier(
  id: string,
  input: UpdateOwnerSubscriptionTierInput,
): Promise<OwnerSubscriptionTierRow> {
  const existing = await getOwnerSubscriptionTierById(id);
  if (!existing) {
    throw new Error("Owner subscription tier not found");
  }

  const patch = applyOwnerTierUpdatePatch(input);
  await db
    .update(ownerSubscriptionTiers)
    .set(patch)
    .where(eq(ownerSubscriptionTiers.id, existing.id));

  const updated = await getOwnerSubscriptionTierById(existing.id);
  if (!updated) throw new Error("Owner subscription tier not found after update");
  return updated;
}

export async function deactivateOwnerSubscriptionTier(
  id: string,
): Promise<OwnerSubscriptionTierRow> {
  return updateOwnerSubscriptionTier(id, { active: false });
}

export async function markOwnerSubscriptionTierSynced(input: {
  id: string;
  openmeterPlanId: string;
  openmeterPlanVersion?: number | null;
}): Promise<void> {
  await db
    .update(ownerSubscriptionTiers)
    .set({
      openmeterPlanId: input.openmeterPlanId,
      openmeterPlanVersion: input.openmeterPlanVersion ?? null,
      lastSyncedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(ownerSubscriptionTiers.id, input.id));
}

/** Default seeded tier key used when callers omit planKey. */
export function defaultOwnerPaidTierKey(): string {
  return OWNER_PAID_PLAN_KEY;
}

export async function requireSelectableOwnerSubscriptionTier(
  planKey: string,
): Promise<OwnerSubscriptionTierRow> {
  const tier = await getOwnerSubscriptionTierByKey(planKey);
  if (tier?.active !== 1) {
    throw new Error("Owner Paid tier is not available");
  }
  if (!parseOwnerTierMonthlyFeeUsd(tier.monthlyFeeUsd)) {
    throw new Error("Owner Paid tier has no monthly fee configured");
  }
  return tier;
}

/** Ensure the legacy seed row exists (idempotent for older DBs). */
export async function ensureDefaultOwnerPaidTierRow(): Promise<OwnerSubscriptionTierRow> {
  const existing = await getOwnerSubscriptionTierByKey(OWNER_PAID_PLAN_KEY);
  if (existing) return existing;
  return createOwnerSubscriptionTier({
    key: OWNER_PAID_PLAN_KEY,
    name: "Owner Paid",
    description:
      "Monthly subscription with included network usage. Overage invoices to your card.",
    monthlyFeeUsd: "20.00",
    includedUsdMicros: "5000000",
    sortOrder: 0,
    active: true,
  });
}

export async function countActiveOwnerSubscriptionTiers(): Promise<number> {
  const rows = await listOwnerSubscriptionTiers({ activeOnly: true });
  return rows.length;
}
