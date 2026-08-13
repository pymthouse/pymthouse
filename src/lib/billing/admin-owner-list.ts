import { and, eq, exists, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";

import { db } from "@/db/index";
import {
  developerApps,
  ownerBillingConfig,
  ownerPaidUpgradeOperations,
  ownerSubscriptionTiers,
  transactions,
  users,
} from "@/db/schema";
import { calendarMonthBoundsUtc } from "@/lib/billing-utils";
import { mergeOwnerBilling } from "@/lib/billing/owner-billing-config";
import { platformDefaultEndUserCap } from "@/lib/billing/platform-billing-defaults";
import { resolvePlatformOwnerStarterIncludedUsdMicros } from "@/lib/billing/platform-owner-starter-default";
import { clampPageParam } from "@/lib/billing/wallet-http";
import { parseUsdMicrosString } from "@/lib/format-usd-micros";
import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "@/lib/openmeter/admin-client";
import {
  NETWORK_FEE_USD_MICROS_METER,
  requireOpenMeterForUsageReads,
  SIGNED_TICKET_COUNT_METER,
} from "@/lib/openmeter/constants";
import {
  buildOwnerMeterSubjects,
  normalizePlatformUserId,
} from "@/lib/openmeter/customer-key";
import { meterRowValueToBigInt } from "@/lib/openmeter/usage-read";

export const ADMIN_OWNER_LIST_DEFAULT_PAGE_SIZE = 25;
export const ADMIN_OWNER_LIST_MAX_PAGE_SIZE = 100;

/** Konnect `subject in [...]` batches; unfiltered meter scans 504. */
const OWNER_LIST_METER_SUBJECT_CHUNK = 80;

export type OwnerListStatusFilter = "all" | "blocked" | "overage" | "attention";
export type OwnerListUsageStatus = "ok" | "blocked" | "overage";
export type OwnerListPlanKind = "starter" | "paid";

export type AdminOwnerListQuery = {
  q: string;
  page: number;
  pageSize: number;
  status: OwnerListStatusFilter;
};

export type AdminOwnerListApp = {
  id: string;
  name: string;
};

export type AdminOwnerCycleUsage = {
  usedUsdMicros: string;
  includedUsdMicros: string;
  remainingUsdMicros: string;
  overageUsdMicros: string;
  requestCount: number;
};

type OwnerListUsageTotals = {
  usedUsdMicros: string;
  requestCount: number;
};

export type OwnerListMeterRow = {
  subject?: string | null;
  value?: unknown;
  groupBy?: Record<string, string | null> | null;
};

export type AdminOwnerListItem = {
  id: string;
  email: string | null;
  name: string | null;
  role: string;
  resolved: ReturnType<typeof mergeOwnerBilling>;
  overrides: {
    starterIncludedUsdMicros: string | null;
    endUserCap: number | null;
    note: string | null;
  } | null;
  ownedApps: AdminOwnerListApp[];
  cycleUsage: AdminOwnerCycleUsage;
  usageStatus: OwnerListUsageStatus;
  planKind: OwnerListPlanKind;
};

export type AdminOwnerListResult = {
  owners: AdminOwnerListItem[];
  page: number;
  pageSize: number;
  totalCount: number;
  cycle: { start: string; end: string };
  statusCounts: {
    all: number;
    ok: number;
    blocked: number;
    overage: number;
    attention: number;
  };
  platformDefault: {
    starterIncludedUsdMicros: string;
    endUserCap: number;
  };
};

function parseStatusFilterParam(raw: string): OwnerListStatusFilter {
  switch (raw) {
    case "blocked":
    case "overage":
    case "attention":
    case "all":
      return raw;
    default:
      return "all";
  }
}

export function parseOwnerListQuery(
  searchParams: URLSearchParams,
): AdminOwnerListQuery {
  return {
    q: searchParams.get("q")?.trim() ?? "",
    page: clampPageParam(searchParams.get("page"), 1, 10_000),
    pageSize: clampPageParam(
      searchParams.get("pageSize"),
      ADMIN_OWNER_LIST_DEFAULT_PAGE_SIZE,
      ADMIN_OWNER_LIST_MAX_PAGE_SIZE,
    ),
    status: parseStatusFilterParam(
      searchParams.get("status")?.trim().toLowerCase() ?? "",
    ),
  };
}

function microsOrZero(raw: string | null | undefined): bigint {
  return parseUsdMicrosString(raw) ?? 0n;
}

/**
 * List-view posture from cycle usage vs plan included.
 *
 * Starter is a hard gate (blocked at/over included). Paid can invoice overage.
 * Prepaid credits and live OpenMeter subscriptions are confirmed on owner detail.
 */
export function classifyOwnerListUsage(input: {
  usedUsdMicros: bigint;
  includedUsdMicros: bigint;
  planKind: OwnerListPlanKind;
}): {
  status: OwnerListUsageStatus;
  remainingUsdMicros: bigint;
  overageUsdMicros: bigint;
} {
  const used = input.usedUsdMicros > 0n ? input.usedUsdMicros : 0n;
  const included = input.includedUsdMicros > 0n ? input.includedUsdMicros : 0n;
  const remaining = included > used ? included - used : 0n;
  const overage = used > included ? used - included : 0n;

  if (used === 0n && included === 0n) {
    return { status: "ok", remainingUsdMicros: 0n, overageUsdMicros: 0n };
  }
  if (input.planKind === "paid") {
    return {
      status: overage > 0n ? "overage" : "ok",
      remainingUsdMicros: remaining,
      overageUsdMicros: overage,
    };
  }
  return {
    status: used >= included ? "blocked" : "ok",
    remainingUsdMicros: remaining,
    overageUsdMicros: overage,
  };
}

export function ownerMatchesStatusFilter(
  status: OwnerListUsageStatus,
  filter: OwnerListStatusFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "attention") return status === "blocked" || status === "overage";
  return status === filter;
}

export function compareOwnersByUsageDesc(
  a: Pick<AdminOwnerListItem, "cycleUsage" | "email" | "id">,
  b: Pick<AdminOwnerListItem, "cycleUsage" | "email" | "id">,
): number {
  const usedA = microsOrZero(a.cycleUsage.usedUsdMicros);
  const usedB = microsOrZero(b.cycleUsage.usedUsdMicros);
  if (usedA !== usedB) return usedB > usedA ? 1 : -1;
  const emailA = (a.email ?? "").toLowerCase();
  const emailB = (b.email ?? "").toLowerCase();
  if (emailA !== emailB) return emailA.localeCompare(emailB);
  return a.id.localeCompare(b.id);
}

/**
 * Subject → owner index for list meter queries. Same dual-read set as
 * owner-detail (`buildOwnerMeterSubjects`): bare id, `owner:{id}`, and
 * transitional compound app keys.
 */
export function indexOwnerListMeterSubjects(
  ownerIds: readonly string[],
  appsByOwner: ReadonlyMap<string, readonly AdminOwnerListApp[]>,
): Map<string, string> {
  const index = new Map<string, string>();
  for (const ownerId of ownerIds) {
    const appIds = (appsByOwner.get(ownerId) ?? []).map((app) => app.id);
    for (const subject of buildOwnerMeterSubjects(ownerId, appIds)) {
      index.set(subject, ownerId);
    }
  }
  return index;
}

export function ownerIdFromOwnerListMeterRow(
  row: OwnerListMeterRow,
  subjectToOwnerId: ReadonlyMap<string, string>,
): string | null {
  const group = row.groupBy ?? {};
  const rawCandidates = [row.subject, group.subject, group.external_user_id];
  for (const raw of rawCandidates) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const exact = subjectToOwnerId.get(trimmed);
    if (exact) return exact;
    const normalized = normalizePlatformUserId(trimmed);
    if (normalized !== trimmed) {
      const viaNorm = subjectToOwnerId.get(normalized);
      if (viaNorm) return viaNorm;
    }
  }
  return null;
}

export function accumulateOwnerListMeterUsage(input: {
  feeRows: readonly OwnerListMeterRow[];
  countRows: readonly OwnerListMeterRow[];
  subjectToOwnerId: ReadonlyMap<string, string>;
}): Map<string, OwnerListUsageTotals> {
  const used = new Map<string, bigint>();
  const counts = new Map<string, number>();
  for (const row of input.feeRows) {
    const ownerId = ownerIdFromOwnerListMeterRow(row, input.subjectToOwnerId);
    if (!ownerId) continue;
    used.set(ownerId, (used.get(ownerId) ?? 0n) + meterRowValueToBigInt(row.value));
  }
  for (const row of input.countRows) {
    const ownerId = ownerIdFromOwnerListMeterRow(row, input.subjectToOwnerId);
    if (!ownerId) continue;
    const n = Number(row.value);
    if (!Number.isFinite(n) || n <= 0) continue;
    counts.set(ownerId, (counts.get(ownerId) ?? 0) + Math.trunc(n));
  }
  const byOwner = new Map<string, OwnerListUsageTotals>();
  for (const ownerId of new Set([...used.keys(), ...counts.keys()])) {
    byOwner.set(ownerId, {
      usedUsdMicros: (used.get(ownerId) ?? 0n).toString(),
      requestCount: counts.get(ownerId) ?? 0,
    });
  }
  return byOwner;
}

function mergeOwnerUsageMaps(
  target: Map<string, OwnerListUsageTotals>,
  source: Map<string, OwnerListUsageTotals>,
): void {
  for (const [ownerId, usage] of source) {
    const existing = target.get(ownerId);
    if (!existing) {
      target.set(ownerId, usage);
      continue;
    }
    target.set(ownerId, {
      usedUsdMicros: (
        (parseUsdMicrosString(existing.usedUsdMicros) ?? 0n) +
        (parseUsdMicrosString(usage.usedUsdMicros) ?? 0n)
      ).toString(),
      requestCount: existing.requestCount + usage.requestCount,
    });
  }
}

function ownerSearchFilter(q: string) {
  if (!q) return undefined;
  const pattern = `%${q}%`;
  return or(
    ilike(users.email, pattern),
    ilike(users.name, pattern),
    eq(users.id, q),
    exists(
      db
        .select({ id: developerApps.id })
        .from(developerApps)
        .where(
          and(
            eq(developerApps.ownerId, users.id),
            or(ilike(developerApps.name, pattern), eq(developerApps.id, q)),
          ),
        ),
    ),
  );
}

type OwnerRow = {
  id: string;
  email: string | null;
  name: string | null;
  role: string;
  starterIncludedUsdMicros: string | null;
  endUserCap: number | null;
  note: string | null;
};

async function loadMatchingOwners(q: string): Promise<OwnerRow[]> {
  const roleFilter = or(eq(users.role, "developer"), eq(users.role, "admin"));
  const searchFilter = ownerSearchFilter(q);
  const whereClause = searchFilter ? and(roleFilter, searchFilter) : roleFilter;
  return db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      starterIncludedUsdMicros: ownerBillingConfig.starterIncludedUsdMicros,
      endUserCap: ownerBillingConfig.endUserCap,
      note: ownerBillingConfig.note,
    })
    .from(users)
    .leftJoin(ownerBillingConfig, eq(ownerBillingConfig.ownerUserId, users.id))
    .where(whereClause);
}

async function loadOwnedAppsByOwner(
  ownerIds: string[],
): Promise<Map<string, AdminOwnerListApp[]>> {
  const byOwner = new Map<string, AdminOwnerListApp[]>();
  if (ownerIds.length === 0) return byOwner;
  const rows = await db
    .select({
      ownerId: developerApps.ownerId,
      id: developerApps.id,
      name: developerApps.name,
    })
    .from(developerApps)
    .where(inArray(developerApps.ownerId, ownerIds));
  for (const row of rows) {
    const list = byOwner.get(row.ownerId) ?? [];
    list.push({ id: row.id, name: row.name });
    byOwner.set(row.ownerId, list);
  }
  for (const list of byOwner.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }
  return byOwner;
}

async function queryOpenMeterCycleUsageByOwner(input: {
  cycle: { start: string; end: string };
  ownerIds: string[];
  appsByOwner: Map<string, AdminOwnerListApp[]>;
}): Promise<Map<string, OwnerListUsageTotals> | null> {
  if (!requireOpenMeterForUsageReads() || !isHostedAdminClientAvailable()) {
    return null;
  }
  const subjectToOwnerId = indexOwnerListMeterSubjects(
    input.ownerIds,
    input.appsByOwner,
  );
  const subjects = [...subjectToOwnerId.keys()];
  if (subjects.length === 0) {
    return new Map();
  }

  const client = getHostedAdminClient();
  const merged = new Map<string, OwnerListUsageTotals>();
  try {
    for (let i = 0; i < subjects.length; i += OWNER_LIST_METER_SUBJECT_CHUNK) {
      const chunk = subjects.slice(i, i + OWNER_LIST_METER_SUBJECT_CHUNK);
      const baseQuery = {
        windowSize: "MONTH" as const,
        from: new Date(input.cycle.start),
        to: new Date(input.cycle.end),
        subject: chunk,
        groupBy: ["external_user_id"],
      };
      const [feeResult, countResult] = await Promise.all([
        client.meters.query(NETWORK_FEE_USD_MICROS_METER, baseQuery),
        client.meters.query(SIGNED_TICKET_COUNT_METER, baseQuery),
      ]);
      mergeOwnerUsageMaps(
        merged,
        accumulateOwnerListMeterUsage({
          feeRows: feeResult.data || [],
          countRows: countResult.data || [],
          subjectToOwnerId,
        }),
      );
    }
    return merged;
  } catch (err) {
    console.warn(
      "admin-owner-list: meter query failed",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

async function loadTransactionCycleUsageByOwner(cycle: {
  start: string;
  end: string;
}): Promise<Map<string, OwnerListUsageTotals>> {
  const rows = await db
    .select({
      ownerId: developerApps.ownerId,
      usedUsdMicros: sql<string>`coalesce(sum(case when ${transactions.networkFeeUsdMicros} ~ '^[0-9]+$' then ${transactions.networkFeeUsdMicros}::bigint else 0 end), 0)::text`,
      requestCount: sql<number>`count(*)::int`,
    })
    .from(transactions)
    .innerJoin(
      developerApps,
      sql`${developerApps.id} = coalesce(${transactions.clientId}, ${transactions.appId})`,
    )
    .where(
      and(
        eq(transactions.type, "usage"),
        eq(transactions.status, "confirmed"),
        gte(transactions.createdAt, cycle.start),
        lte(transactions.createdAt, cycle.end),
      ),
    )
    .groupBy(developerApps.ownerId);

  const byOwner = new Map<string, OwnerListUsageTotals>();
  for (const row of rows) {
    const requestCount = Number(row.requestCount);
    byOwner.set(row.ownerId, {
      usedUsdMicros: row.usedUsdMicros,
      requestCount: Number.isFinite(requestCount) ? requestCount : 0,
    });
  }
  return byOwner;
}

async function loadCycleUsageByOwner(input: {
  cycle: { start: string; end: string };
  ownerIds: string[];
  appsByOwner: Map<string, AdminOwnerListApp[]>;
}): Promise<Map<string, OwnerListUsageTotals>> {
  const fromOpenMeter = await queryOpenMeterCycleUsageByOwner(input);
  if (fromOpenMeter) return fromOpenMeter;
  return loadTransactionCycleUsageByOwner(input.cycle);
}

async function loadPaidPlanByOwner(
  ownerIds: string[],
): Promise<Map<string, { planKey: string; includedUsdMicros: string | null }>> {
  const byOwner = new Map<string, { planKey: string; includedUsdMicros: string | null }>();
  if (ownerIds.length === 0) return byOwner;

  const [ops, tiers] = await Promise.all([
    db
      .select({
        ownerUserId: ownerPaidUpgradeOperations.ownerUserId,
        planKey: ownerPaidUpgradeOperations.planKey,
        updatedAt: ownerPaidUpgradeOperations.updatedAt,
      })
      .from(ownerPaidUpgradeOperations)
      .where(
        and(
          inArray(ownerPaidUpgradeOperations.ownerUserId, ownerIds),
          eq(ownerPaidUpgradeOperations.status, "completed"),
        ),
      ),
    db
      .select({
        key: ownerSubscriptionTiers.key,
        includedUsdMicros: ownerSubscriptionTiers.includedUsdMicros,
      })
      .from(ownerSubscriptionTiers),
  ]);

  const includedByKey = new Map(
    tiers.map((tier) => [tier.key, tier.includedUsdMicros]),
  );
  const latest = new Map<
    string,
    { planKey: string; includedUsdMicros: string | null; updatedAt: string }
  >();
  for (const op of ops) {
    const existing = latest.get(op.ownerUserId);
    if (existing && op.updatedAt <= existing.updatedAt) continue;
    latest.set(op.ownerUserId, {
      planKey: op.planKey,
      includedUsdMicros: includedByKey.get(op.planKey) ?? null,
      updatedAt: op.updatedAt,
    });
  }
  for (const [ownerId, value] of latest) {
    byOwner.set(ownerId, {
      planKey: value.planKey,
      includedUsdMicros: value.includedUsdMicros,
    });
  }
  return byOwner;
}

/**
 * GET /api/v1/admin/billing/owners list payload: search by email/name/id/app,
 * current-cycle usage, blocked/overage filters, most-used first.
 */
export async function listAdminBillingOwners(
  query: AdminOwnerListQuery,
): Promise<AdminOwnerListResult> {
  const cycleBounds = calendarMonthBoundsUtc(new Date());
  const cycle = { start: cycleBounds.start, end: cycleBounds.end };
  const platformDefault = await resolvePlatformOwnerStarterIncludedUsdMicros();
  const defaults = {
    starterIncludedUsdMicros: platformDefault,
    endUserCap: platformDefaultEndUserCap(),
  };

  const rows = await loadMatchingOwners(query.q);
  const ownerIds = rows.map((row) => row.id);
  if (ownerIds.length === 0) {
    return {
      owners: [],
      page: query.page,
      pageSize: query.pageSize,
      totalCount: 0,
      cycle,
      statusCounts: { all: 0, ok: 0, blocked: 0, overage: 0, attention: 0 },
      platformDefault: {
        starterIncludedUsdMicros: platformDefault,
        endUserCap: defaults.endUserCap,
      },
    };
  }
  const appsByOwner = await loadOwnedAppsByOwner(ownerIds);
  const [usageByOwner, paidByOwner] = await Promise.all([
    loadCycleUsageByOwner({
      cycle,
      ownerIds,
      appsByOwner,
    }),
    loadPaidPlanByOwner(ownerIds),
  ]);

  const items: AdminOwnerListItem[] = rows.map((row) => {
    const hasRow =
      row.starterIncludedUsdMicros != null ||
      row.endUserCap != null ||
      row.note != null;
    const overrides = hasRow
      ? {
          starterIncludedUsdMicros: row.starterIncludedUsdMicros,
          endUserCap: row.endUserCap,
          note: row.note,
        }
      : null;
    const resolved = mergeOwnerBilling(overrides, defaults);
    const paid = paidByOwner.get(row.id);
    const planKind: OwnerListPlanKind = paid ? "paid" : "starter";
    const includedUsdMicros =
      paid?.includedUsdMicros && /^\d+$/.test(paid.includedUsdMicros)
        ? paid.includedUsdMicros
        : resolved.starterIncludedUsdMicros;
    const usage = usageByOwner.get(row.id);
    const usedUsdMicros = usage?.usedUsdMicros ?? "0";
    const classified = classifyOwnerListUsage({
      usedUsdMicros: microsOrZero(usedUsdMicros),
      includedUsdMicros: microsOrZero(includedUsdMicros),
      planKind,
    });
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      resolved,
      overrides,
      ownedApps: appsByOwner.get(row.id) ?? [],
      cycleUsage: {
        usedUsdMicros,
        includedUsdMicros,
        remainingUsdMicros: classified.remainingUsdMicros.toString(),
        overageUsdMicros: classified.overageUsdMicros.toString(),
        requestCount: usage?.requestCount ?? 0,
      },
      usageStatus: classified.status,
      planKind,
    };
  });

  const statusCounts = {
    all: items.length,
    ok: 0,
    blocked: 0,
    overage: 0,
    attention: 0,
  };
  for (const item of items) {
    statusCounts[item.usageStatus] += 1;
    if (item.usageStatus === "blocked" || item.usageStatus === "overage") {
      statusCounts.attention += 1;
    }
  }

  const filtered = items.filter((item) =>
    ownerMatchesStatusFilter(item.usageStatus, query.status),
  );
  filtered.sort(compareOwnersByUsageDesc);

  const totalCount = filtered.length;
  const offset = (query.page - 1) * query.pageSize;
  const owners = filtered.slice(offset, offset + query.pageSize);

  return {
    owners,
    page: query.page,
    pageSize: query.pageSize,
    totalCount,
    cycle,
    statusCounts,
    platformDefault: {
      starterIncludedUsdMicros: platformDefault,
      endUserCap: defaults.endUserCap,
    },
  };
}
