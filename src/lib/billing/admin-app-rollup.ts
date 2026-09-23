import { and, eq, exists, ilike, inArray, or, sql } from "drizzle-orm";

import { db } from "@/db/index";
import {
  appBillingConfig,
  appUsers,
  developerApps,
  oidcClients,
  ownerBillingConfig,
  users,
} from "@/db/schema";
import { calendarMonthBoundsUtc } from "@/lib/billing-utils";
import {
  classifyOwnerListUsage,
  loadCycleUsageByOwner,
  loadPaidPlanByOwner,
  type OwnerListPlanKind,
  type OwnerListUsageStatus,
} from "@/lib/billing/admin-owner-list";
import { mergeOwnerBilling } from "@/lib/billing/owner-billing-config";
import { ownerSpendableRemainingUsdMicros } from "@/lib/billing/owner-billing-pressure";
import { platformDefaultEndUserCap } from "@/lib/billing/platform-billing-defaults";
import { resolvePlatformOwnerStarterIncludedUsdMicros } from "@/lib/billing/platform-owner-starter-default";
import { clampPageParam } from "@/lib/billing/wallet-http";
import { parseUsdMicrosString } from "@/lib/format-usd-micros";
import { getOwnerPrepaidCreditBalance } from "@/lib/openmeter/credit-allowance-summary";
import { queryOpenMeterIdentityTotals } from "@/lib/openmeter/usage-read";

export const ADMIN_APP_LIST_DEFAULT_PAGE_SIZE = 25;
export const ADMIN_APP_LIST_MAX_PAGE_SIZE = 100;
export const ADMIN_APP_USERS_DEFAULT_PAGE_SIZE = 25;
export const ADMIN_APP_USERS_MAX_PAGE_SIZE = 100;

export type AppListStatusFilter = "all" | "blocked" | "overage" | "attention";
export type AppListBillingModeFilter = "all" | "owner_rollup" | "merchant";

export type AdminAppListQuery = {
  q: string;
  page: number;
  pageSize: number;
  status: AppListStatusFilter;
  billingMode: AppListBillingModeFilter;
};

export type AdminAppUserQuery = {
  q: string;
  page: number;
  pageSize: number;
};

export type AppUserCreditDecision =
  | { ok: true; mode: "user_wallet" }
  | { ok: true; mode: "self_owner_wallet"; ownerUserId: string }
  | {
      ok: false;
      status: 409;
      code: "owner_rollup_credit_owner";
      ownerUserId: string;
      error: string;
    };

export type AdminAppMatchedUser = {
  externalUserId: string;
  email: string | null;
};

export type AdminAppOwnerSummary = {
  id: string;
  email: string | null;
  name: string | null;
  planKind: OwnerListPlanKind;
  usageStatus: OwnerListUsageStatus;
  cycleUsage: {
    usedUsdMicros: string;
    includedUsdMicros: string;
    remainingUsdMicros: string;
    overageUsdMicros: string;
    requestCount: number;
  };
};

export type AdminAppListItem = {
  id: string;
  name: string;
  publicClientId: string;
  billingMode: "owner_rollup" | "merchant";
  isPlatformDefault: boolean;
  sharesOwnerCostRail: boolean;
  owner: AdminAppOwnerSummary;
  m2mUserCount: number;
  blockedM2mUserCount: number;
  matchedUsers: AdminAppMatchedUser[];
};

export type AdminAppListResult = {
  apps: AdminAppListItem[];
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
};

export type AdminAppUserItem = {
  id: string;
  externalUserId: string;
  email: string | null;
  status: string;
  cycleUsage: {
    usedUsdMicros: string;
    requestCount: number;
  };
  spendable: {
    source: "owner_wallet" | "user_wallet" | "self_owner_wallet";
    balanceUsdMicros: string | null;
    includedRemainingUsdMicros: string | null;
    blocked: boolean;
  };
  canGrantDirectly: boolean;
};

export type AdminAppDetail = {
  app: AdminAppListItem;
  owner: AdminAppOwnerSummary & {
    creditAllowance: {
      balanceUsdMicros: string;
      consumedUsdMicros: string;
      lifetimeGrantedUsdMicros: string;
    } | null;
    spendableUsdMicros: string;
  };
  creditPolicy: {
    m2mDirectGrants: "denied" | "allowed";
    ownerGrantsUnblockM2m: boolean;
    explanation: string;
  };
  users: {
    items: AdminAppUserItem[];
    page: number;
    pageSize: number;
    totalCount: number;
  };
};

type AppRow = {
  id: string;
  name: string;
  publicClientId: string | null;
  ownerId: string;
  ownerEmail: string | null;
  ownerName: string | null;
  billingMode: string | null;
  isPlatformDefault: number;
  starterIncludedUsdMicros: string | null;
  endUserCap: number | null;
  note: string | null;
};

function parseStatusFilter(raw: string): AppListStatusFilter {
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

function parseBillingModeFilter(raw: string): AppListBillingModeFilter {
  switch (raw) {
    case "owner_rollup":
    case "merchant":
    case "all":
      return raw;
    default:
      return "all";
  }
}

export function parseAppListQuery(
  searchParams: URLSearchParams,
): AdminAppListQuery {
  return {
    q: searchParams.get("q")?.trim() ?? "",
    page: clampPageParam(searchParams.get("page"), 1, 10_000),
    pageSize: clampPageParam(
      searchParams.get("pageSize"),
      ADMIN_APP_LIST_DEFAULT_PAGE_SIZE,
      ADMIN_APP_LIST_MAX_PAGE_SIZE,
    ),
    status: parseStatusFilter(
      searchParams.get("status")?.trim().toLowerCase() ?? "",
    ),
    billingMode: parseBillingModeFilter(
      searchParams.get("billingMode")?.trim().toLowerCase() ?? "",
    ),
  };
}

export function parseAppUserListQuery(
  searchParams: URLSearchParams,
): AdminAppUserQuery {
  return {
    q: searchParams.get("q")?.trim() ?? "",
    page: clampPageParam(searchParams.get("page"), 1, 10_000),
    pageSize: clampPageParam(
      searchParams.get("pageSize"),
      ADMIN_APP_USERS_DEFAULT_PAGE_SIZE,
      ADMIN_APP_USERS_MAX_PAGE_SIZE,
    ),
  };
}

export function normalizeAppBillingMode(
  raw: string | null | undefined,
): "owner_rollup" | "merchant" {
  return raw === "merchant" ? "merchant" : "owner_rollup";
}

/**
 * M2M/end-user spendable lives on the app owner's wallet unless the app is
 * merchant (per-user `eu_…` wallets) or the platform default app (each member
 * is their own owner).
 */
export function appSharesOwnerCostRail(input: {
  billingMode: "owner_rollup" | "merchant";
  isPlatformDefault: boolean;
}): boolean {
  return input.billingMode !== "merchant" && !input.isPlatformDefault;
}

export function blockedRollupM2mUserCount(input: {
  sharesOwnerCostRail: boolean;
  ownerUsageStatus: OwnerListUsageStatus;
  activeM2mUserCount: number;
}): number {
  if (!input.sharesOwnerCostRail || input.ownerUsageStatus !== "blocked") {
    return 0;
  }
  return input.activeM2mUserCount;
}

export function appNeedsAttention(input: {
  sharesOwnerCostRail: boolean;
  ownerUsageStatus: OwnerListUsageStatus;
}): boolean {
  if (!input.sharesOwnerCostRail) return false;
  return (
    input.ownerUsageStatus === "blocked" || input.ownerUsageStatus === "overage"
  );
}

export function appMatchesStatusFilter(
  item: {
    blockedM2mUserCount: number;
    sharesOwnerCostRail: boolean;
    owner: { usageStatus: OwnerListUsageStatus };
  },
  filter: AppListStatusFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "blocked") return item.blockedM2mUserCount > 0;
  if (filter === "overage") {
    return (
      item.sharesOwnerCostRail && item.owner.usageStatus === "overage"
    );
  }
  return appNeedsAttention({
    sharesOwnerCostRail: item.sharesOwnerCostRail,
    ownerUsageStatus: item.owner.usageStatus,
  });
}

export function decideAppUserCreditGrant(input: {
  sharesOwnerCostRail: boolean;
  isPlatformDefault: boolean;
  ownerUserId: string;
  externalUserId: string;
}): AppUserCreditDecision {
  if (input.sharesOwnerCostRail) {
    return {
      ok: false,
      status: 409,
      code: "owner_rollup_credit_owner",
      ownerUserId: input.ownerUserId,
      error:
        "This app uses owner rollup. Prepaid credits apply to the owner wallet and unblock all M2M users. Grant via POST /api/v1/admin/billing/owners/" +
        input.ownerUserId +
        "/grants.",
    };
  }
  if (input.isPlatformDefault) {
    const ownerUserId = input.externalUserId.trim();
    return { ok: true, mode: "self_owner_wallet", ownerUserId };
  }
  return { ok: true, mode: "user_wallet" };
}

export function ownerRollupSpendableUsdMicros(input: {
  creditBalanceUsdMicros: string | null | undefined;
  includedUsdMicros: string;
  usedUsdMicros: string;
}): string {
  return ownerSpendableRemainingUsdMicros({
    creditBalanceUsdMicros: input.creditBalanceUsdMicros,
    subscriptions: [
      {
        discountUsdMicros: input.includedUsdMicros,
        usedUsdMicros: input.usedUsdMicros,
      },
    ],
  }).toString();
}

function microsOrZero(raw: string | null | undefined): bigint {
  return parseUsdMicrosString(raw) ?? 0n;
}

function appSearchFilter(q: string) {
  if (!q) return undefined;
  const pattern = `%${q}%`;
  return or(
    ilike(developerApps.name, pattern),
    eq(developerApps.id, q),
    ilike(oidcClients.clientId, pattern),
    eq(oidcClients.clientId, q),
    ilike(users.email, pattern),
    ilike(users.name, pattern),
    eq(users.id, q),
    exists(
      db
        .select({ id: appUsers.id })
        .from(appUsers)
        .where(
          and(
            eq(appUsers.clientId, developerApps.id),
            or(
              ilike(appUsers.email, pattern),
              ilike(appUsers.externalUserId, pattern),
              eq(appUsers.externalUserId, q),
              eq(appUsers.id, q),
            ),
          ),
        ),
    ),
  );
}

async function loadMatchingApps(q: string): Promise<AppRow[]> {
  const searchFilter = appSearchFilter(q);
  return db
    .select({
      id: developerApps.id,
      name: developerApps.name,
      publicClientId: oidcClients.clientId,
      ownerId: developerApps.ownerId,
      ownerEmail: users.email,
      ownerName: users.name,
      billingMode: appBillingConfig.billingMode,
      isPlatformDefault: developerApps.isPlatformDefault,
      starterIncludedUsdMicros: ownerBillingConfig.starterIncludedUsdMicros,
      endUserCap: ownerBillingConfig.endUserCap,
      note: ownerBillingConfig.note,
    })
    .from(developerApps)
    .innerJoin(users, eq(developerApps.ownerId, users.id))
    .leftJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .leftJoin(
      appBillingConfig,
      eq(appBillingConfig.clientId, developerApps.id),
    )
    .leftJoin(
      ownerBillingConfig,
      eq(ownerBillingConfig.ownerUserId, developerApps.ownerId),
    )
    .where(searchFilter);
}

async function loadActiveM2mCounts(
  appIds: string[],
): Promise<Map<string, number>> {
  const byApp = new Map<string, number>();
  if (appIds.length === 0) return byApp;
  const rows = await db
    .select({
      appId: appUsers.clientId,
      count: sql<number>`count(*)::int`,
    })
    .from(appUsers)
    .where(
      and(inArray(appUsers.clientId, appIds), eq(appUsers.status, "active")),
    )
    .groupBy(appUsers.clientId);
  for (const row of rows) {
    const count = Number(row.count);
    byApp.set(row.appId, Number.isFinite(count) ? count : 0);
  }
  return byApp;
}

async function loadMatchedUsersByApp(input: {
  q: string;
  appIds: string[];
}): Promise<Map<string, AdminAppMatchedUser[]>> {
  const byApp = new Map<string, AdminAppMatchedUser[]>();
  if (!input.q || input.appIds.length === 0) return byApp;
  const pattern = `%${input.q}%`;
  const rows = await db
    .select({
      appId: appUsers.clientId,
      externalUserId: appUsers.externalUserId,
      email: appUsers.email,
    })
    .from(appUsers)
    .where(
      and(
        inArray(appUsers.clientId, input.appIds),
        or(
          ilike(appUsers.email, pattern),
          ilike(appUsers.externalUserId, pattern),
          eq(appUsers.externalUserId, input.q),
          eq(appUsers.id, input.q),
        ),
      ),
    );
  for (const row of rows) {
    const list = byApp.get(row.appId) ?? [];
    if (list.length < 5) {
      list.push({
        externalUserId: row.externalUserId,
        email: row.email,
      });
      byApp.set(row.appId, list);
    }
  }
  return byApp;
}

function compareAppsByAttentionThenUsage(
  a: AdminAppListItem,
  b: AdminAppListItem,
): number {
  const blockedA = a.blockedM2mUserCount > 0 ? 1 : 0;
  const blockedB = b.blockedM2mUserCount > 0 ? 1 : 0;
  if (blockedA !== blockedB) return blockedB - blockedA;
  const usedA = microsOrZero(a.owner.cycleUsage.usedUsdMicros);
  const usedB = microsOrZero(b.owner.cycleUsage.usedUsdMicros);
  if (usedA !== usedB) return usedB > usedA ? 1 : -1;
  return a.name.localeCompare(b.name);
}

function buildOwnerSummary(input: {
  ownerId: string;
  email: string | null;
  name: string | null;
  starterIncludedUsdMicros: string | null;
  endUserCap: number | null;
  note: string | null;
  defaults: { starterIncludedUsdMicros: string; endUserCap: number };
  paid: { planKey: string; includedUsdMicros: string | null } | undefined;
  usage: { usedUsdMicros: string; requestCount: number } | undefined;
}): AdminAppOwnerSummary {
  const hasRow =
    input.starterIncludedUsdMicros != null ||
    input.endUserCap != null ||
    input.note != null;
  const overrides = hasRow
    ? {
        starterIncludedUsdMicros: input.starterIncludedUsdMicros,
        endUserCap: input.endUserCap,
        note: input.note,
      }
    : null;
  const resolved = mergeOwnerBilling(overrides, input.defaults);
  const planKind: OwnerListPlanKind = input.paid ? "paid" : "starter";
  const includedUsdMicros =
    input.paid?.includedUsdMicros && /^\d+$/.test(input.paid.includedUsdMicros)
      ? input.paid.includedUsdMicros
      : resolved.starterIncludedUsdMicros;
  const usedUsdMicros = input.usage?.usedUsdMicros ?? "0";
  const classified = classifyOwnerListUsage({
    usedUsdMicros: microsOrZero(usedUsdMicros),
    includedUsdMicros: microsOrZero(includedUsdMicros),
    planKind,
  });
  return {
    id: input.ownerId,
    email: input.email,
    name: input.name,
    planKind,
    usageStatus: classified.status,
    cycleUsage: {
      usedUsdMicros,
      includedUsdMicros,
      remainingUsdMicros: classified.remainingUsdMicros.toString(),
      overageUsdMicros: classified.overageUsdMicros.toString(),
      requestCount: input.usage?.requestCount ?? 0,
    },
  };
}

function toListItem(input: {
  row: AppRow;
  owner: AdminAppOwnerSummary;
  m2mUserCount: number;
  matchedUsers: AdminAppMatchedUser[];
}): AdminAppListItem {
  const billingMode = normalizeAppBillingMode(input.row.billingMode);
  const isPlatformDefault = input.row.isPlatformDefault === 1;
  const sharesOwnerCostRail = appSharesOwnerCostRail({
    billingMode,
    isPlatformDefault,
  });
  return {
    id: input.row.id,
    name: input.row.name,
    publicClientId: input.row.publicClientId?.trim() || input.row.id,
    billingMode,
    isPlatformDefault,
    sharesOwnerCostRail,
    owner: input.owner,
    m2mUserCount: input.m2mUserCount,
    blockedM2mUserCount: blockedRollupM2mUserCount({
      sharesOwnerCostRail,
      ownerUsageStatus: input.owner.usageStatus,
      activeM2mUserCount: input.m2mUserCount,
    }),
    matchedUsers: input.matchedUsers,
  };
}

export async function listAdminBillingApps(
  query: AdminAppListQuery,
): Promise<AdminAppListResult> {
  const cycleBounds = calendarMonthBoundsUtc(new Date());
  const cycle = { start: cycleBounds.start, end: cycleBounds.end };
  const platformDefault = await resolvePlatformOwnerStarterIncludedUsdMicros();
  const defaults = {
    starterIncludedUsdMicros: platformDefault,
    endUserCap: platformDefaultEndUserCap(),
  };

  const rows = await loadMatchingApps(query.q);
  const emptyCounts = {
    all: 0,
    ok: 0,
    blocked: 0,
    overage: 0,
    attention: 0,
  };
  if (rows.length === 0) {
    return {
      apps: [],
      page: query.page,
      pageSize: query.pageSize,
      totalCount: 0,
      cycle,
      statusCounts: emptyCounts,
    };
  }

  const ownerIds = [...new Set(rows.map((row) => row.ownerId))];
  const appIds = rows.map((row) => row.id);
  const appsByOwner = new Map<
    string,
    Array<{ publicClientId: string; id: string; name: string }>
  >();
  for (const row of rows) {
    const list = appsByOwner.get(row.ownerId) ?? [];
    list.push({
      id: row.id,
      name: row.name,
      publicClientId: row.publicClientId?.trim() || row.id,
    });
    appsByOwner.set(row.ownerId, list);
  }

  const [usageByOwner, paidByOwner, m2mCounts] = await Promise.all([
    loadCycleUsageByOwner({
      cycle,
      ownerIds,
      appsByOwner,
    }),
    loadPaidPlanByOwner(ownerIds),
    loadActiveM2mCounts(appIds),
  ]);

  const ownerSummaries = new Map<string, AdminAppOwnerSummary>();
  for (const row of rows) {
    if (ownerSummaries.has(row.ownerId)) continue;
    ownerSummaries.set(
      row.ownerId,
      buildOwnerSummary({
        ownerId: row.ownerId,
        email: row.ownerEmail,
        name: row.ownerName,
        starterIncludedUsdMicros: row.starterIncludedUsdMicros,
        endUserCap: row.endUserCap,
        note: row.note,
        defaults,
        paid: paidByOwner.get(row.ownerId),
        usage: usageByOwner.get(row.ownerId),
      }),
    );
  }

  const items: AdminAppListItem[] = rows.map((row) =>
    toListItem({
      row,
      owner: ownerSummaries.get(row.ownerId)!,
      m2mUserCount: m2mCounts.get(row.id) ?? 0,
      matchedUsers: [],
    }),
  );

  const byMode =
    query.billingMode === "all"
      ? items
      : items.filter((item) => item.billingMode === query.billingMode);

  const statusCounts = { ...emptyCounts, all: byMode.length };
  for (const item of byMode) {
    if (item.blockedM2mUserCount > 0) statusCounts.blocked += 1;
    else if (item.sharesOwnerCostRail && item.owner.usageStatus === "overage") {
      statusCounts.overage += 1;
    } else {
      statusCounts.ok += 1;
    }
    if (
      appNeedsAttention({
        sharesOwnerCostRail: item.sharesOwnerCostRail,
        ownerUsageStatus: item.owner.usageStatus,
      })
    ) {
      statusCounts.attention += 1;
    }
  }

  const filtered = byMode.filter((item) =>
    appMatchesStatusFilter(item, query.status),
  );
  filtered.sort(compareAppsByAttentionThenUsage);

  const totalCount = filtered.length;
  const offset = (query.page - 1) * query.pageSize;
  const pageItems = filtered.slice(offset, offset + query.pageSize);
  const matched = await loadMatchedUsersByApp({
    q: query.q,
    appIds: pageItems.map((item) => item.id),
  });
  for (const item of pageItems) {
    item.matchedUsers = matched.get(item.id) ?? [];
  }

  return {
    apps: pageItems,
    page: query.page,
    pageSize: query.pageSize,
    totalCount,
    cycle,
    statusCounts,
  };
}

async function loadAppRow(appId: string): Promise<AppRow | null> {
  const id = appId.trim();
  if (!id) return null;
  const byId = await db
    .select({
      id: developerApps.id,
      name: developerApps.name,
      publicClientId: oidcClients.clientId,
      ownerId: developerApps.ownerId,
      ownerEmail: users.email,
      ownerName: users.name,
      billingMode: appBillingConfig.billingMode,
      isPlatformDefault: developerApps.isPlatformDefault,
      starterIncludedUsdMicros: ownerBillingConfig.starterIncludedUsdMicros,
      endUserCap: ownerBillingConfig.endUserCap,
      note: ownerBillingConfig.note,
    })
    .from(developerApps)
    .innerJoin(users, eq(developerApps.ownerId, users.id))
    .leftJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .leftJoin(
      appBillingConfig,
      eq(appBillingConfig.clientId, developerApps.id),
    )
    .leftJoin(
      ownerBillingConfig,
      eq(ownerBillingConfig.ownerUserId, developerApps.ownerId),
    )
    .where(eq(developerApps.id, id))
    .limit(1);
  if (byId[0]) return byId[0];

  const byPublic = await db
    .select({
      id: developerApps.id,
      name: developerApps.name,
      publicClientId: oidcClients.clientId,
      ownerId: developerApps.ownerId,
      ownerEmail: users.email,
      ownerName: users.name,
      billingMode: appBillingConfig.billingMode,
      isPlatformDefault: developerApps.isPlatformDefault,
      starterIncludedUsdMicros: ownerBillingConfig.starterIncludedUsdMicros,
      endUserCap: ownerBillingConfig.endUserCap,
      note: ownerBillingConfig.note,
    })
    .from(developerApps)
    .innerJoin(users, eq(developerApps.ownerId, users.id))
    .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .leftJoin(
      appBillingConfig,
      eq(appBillingConfig.clientId, developerApps.id),
    )
    .leftJoin(
      ownerBillingConfig,
      eq(ownerBillingConfig.ownerUserId, developerApps.ownerId),
    )
    .where(eq(oidcClients.clientId, id))
    .limit(1);
  return byPublic[0] ?? null;
}

async function loadAppUsersPage(input: {
  appId: string;
  q: string;
  page: number;
  pageSize: number;
}): Promise<{
  items: Array<{
    id: string;
    externalUserId: string;
    email: string | null;
    status: string;
  }>;
  totalCount: number;
}> {
  const pattern = input.q ? `%${input.q}%` : null;
  const search = pattern
    ? or(
        ilike(appUsers.email, pattern),
        ilike(appUsers.externalUserId, pattern),
        eq(appUsers.externalUserId, input.q),
        eq(appUsers.id, input.q),
      )
    : undefined;
  const whereClause = search
    ? and(eq(appUsers.clientId, input.appId), search)
    : eq(appUsers.clientId, input.appId);

  const countRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(appUsers)
    .where(whereClause);
  const totalCount = Number(countRows[0]?.count ?? 0);
  const offset = (input.page - 1) * input.pageSize;
  const items = await db
    .select({
      id: appUsers.id,
      externalUserId: appUsers.externalUserId,
      email: appUsers.email,
      status: appUsers.status,
    })
    .from(appUsers)
    .where(whereClause)
    .orderBy(appUsers.createdAt)
    .limit(input.pageSize)
    .offset(offset);
  return {
    items,
    totalCount: Number.isFinite(totalCount) ? totalCount : 0,
  };
}

function creditPolicyForApp(item: AdminAppListItem): AdminAppDetail["creditPolicy"] {
  if (item.sharesOwnerCostRail) {
    return {
      m2mDirectGrants: "denied",
      ownerGrantsUnblockM2m: true,
      explanation:
        "Owner-rollup M2M users share the owner prepaid wallet. Credit the owner to unblock them; do not grant to an M2M user directly.",
    };
  }
  if (item.isPlatformDefault) {
    return {
      m2mDirectGrants: "allowed",
      ownerGrantsUnblockM2m: false,
      explanation:
        "Platform default app members bill their own owner wallets. Credit that user as an owner, not this app's owner.",
    };
  }
  return {
    m2mDirectGrants: "allowed",
    ownerGrantsUnblockM2m: false,
    explanation:
      "Merchant M2M users have their own prepaid wallets. Credit the user directly.",
  };
}

export async function getAdminBillingApp(
  appId: string,
  userQuery: AdminAppUserQuery,
): Promise<AdminAppDetail | null> {
  const row = await loadAppRow(appId);
  if (!row) return null;

  const cycleBounds = calendarMonthBoundsUtc(new Date());
  const cycle = { start: cycleBounds.start, end: cycleBounds.end };
  const platformDefault = await resolvePlatformOwnerStarterIncludedUsdMicros();
  const defaults = {
    starterIncludedUsdMicros: platformDefault,
    endUserCap: platformDefaultEndUserCap(),
  };

  const appsByOwner = new Map([
    [
      row.ownerId,
      [
        {
          id: row.id,
          name: row.name,
          publicClientId: row.publicClientId?.trim() || row.id,
        },
      ],
    ],
  ]);

  const [usageByOwner, paidByOwner, m2mCounts, usersPage, creditAllowance] =
    await Promise.all([
      loadCycleUsageByOwner({
        cycle,
        ownerIds: [row.ownerId],
        appsByOwner,
      }),
      loadPaidPlanByOwner([row.ownerId]),
      loadActiveM2mCounts([row.id]),
      loadAppUsersPage({
        appId: row.id,
        q: userQuery.q,
        page: userQuery.page,
        pageSize: userQuery.pageSize,
      }),
      getOwnerPrepaidCreditBalance(row.ownerId).catch(() => null),
    ]);

  const owner = buildOwnerSummary({
    ownerId: row.ownerId,
    email: row.ownerEmail,
    name: row.ownerName,
    starterIncludedUsdMicros: row.starterIncludedUsdMicros,
    endUserCap: row.endUserCap,
    note: row.note,
    defaults,
    paid: paidByOwner.get(row.ownerId),
    usage: usageByOwner.get(row.ownerId),
  });
  const app = toListItem({
    row,
    owner,
    m2mUserCount: m2mCounts.get(row.id) ?? 0,
    matchedUsers: [],
  });

  const actorUsage = new Map<string, { usedUsdMicros: string; requestCount: number }>();
  try {
    const identityRows = await queryOpenMeterIdentityTotals({
      clientId: app.publicClientId,
      startDate: cycle.start,
      endDate: cycle.end,
    });
    for (const identity of identityRows) {
      actorUsage.set(identity.externalUserId, {
        usedUsdMicros: identity.networkFeeUsdMicros,
        requestCount: identity.requestCount,
      });
    }
  } catch (err) {
    console.warn(
      "admin-app-rollup: identity totals failed",
      err instanceof Error ? err.message : String(err),
    );
  }

  const spendableUsdMicros = ownerRollupSpendableUsdMicros({
    creditBalanceUsdMicros: creditAllowance?.balanceUsdMicros,
    includedUsdMicros: owner.cycleUsage.includedUsdMicros,
    usedUsdMicros: owner.cycleUsage.usedUsdMicros,
  });
  const ownerBlocked =
    owner.planKind === "starter" &&
    microsOrZero(spendableUsdMicros) === 0n &&
    (owner.usageStatus === "blocked" ||
      microsOrZero(owner.cycleUsage.usedUsdMicros) > 0n);

  const userItems: AdminAppUserItem[] = usersPage.items.map((user) => {
    const usage = actorUsage.get(user.externalUserId) ?? {
      usedUsdMicros: "0",
      requestCount: 0,
    };
    if (app.sharesOwnerCostRail) {
      return {
        id: user.id,
        externalUserId: user.externalUserId,
        email: user.email,
        status: user.status,
        cycleUsage: usage,
        spendable: {
          source: "owner_wallet",
          balanceUsdMicros: creditAllowance?.balanceUsdMicros ?? "0",
          includedRemainingUsdMicros: owner.cycleUsage.remainingUsdMicros,
          blocked: ownerBlocked,
        },
        canGrantDirectly: false,
      };
    }
    if (app.isPlatformDefault) {
      return {
        id: user.id,
        externalUserId: user.externalUserId,
        email: user.email,
        status: user.status,
        cycleUsage: usage,
        spendable: {
          source: "self_owner_wallet",
          balanceUsdMicros: null,
          includedRemainingUsdMicros: null,
          blocked: false,
        },
        canGrantDirectly: true,
      };
    }
    return {
      id: user.id,
      externalUserId: user.externalUserId,
      email: user.email,
      status: user.status,
      cycleUsage: usage,
      spendable: {
        source: "user_wallet",
        balanceUsdMicros: null,
        includedRemainingUsdMicros: null,
        blocked: false,
      },
      canGrantDirectly: true,
    };
  });

  return {
    app,
    owner: {
      ...owner,
      creditAllowance: creditAllowance
        ? {
            balanceUsdMicros: creditAllowance.balanceUsdMicros,
            consumedUsdMicros: creditAllowance.consumedUsdMicros,
            lifetimeGrantedUsdMicros: creditAllowance.lifetimeGrantedUsdMicros,
          }
        : null,
      spendableUsdMicros,
    },
    creditPolicy: creditPolicyForApp(app),
    users: {
      items: userItems,
      page: userQuery.page,
      pageSize: userQuery.pageSize,
      totalCount: usersPage.totalCount,
    },
  };
}

export async function loadAppCreditContext(appId: string): Promise<{
  id: string;
  publicClientId: string;
  ownerUserId: string;
  billingMode: "owner_rollup" | "merchant";
  isPlatformDefault: boolean;
  sharesOwnerCostRail: boolean;
} | null> {
  const row = await loadAppRow(appId);
  if (!row) return null;
  const billingMode = normalizeAppBillingMode(row.billingMode);
  const isPlatformDefault = row.isPlatformDefault === 1;
  return {
    id: row.id,
    publicClientId: row.publicClientId?.trim() || row.id,
    ownerUserId: row.ownerId,
    billingMode,
    isPlatformDefault,
    sharesOwnerCostRail: appSharesOwnerCostRail({
      billingMode,
      isPlatformDefault,
    }),
  };
}
