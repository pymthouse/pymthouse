import { getServerSession } from "next-auth";
import { eq } from "drizzle-orm";
import { authOptions } from "@/lib/next-auth-options";
import { db } from "@/db/index";
import { developerApps, users } from "@/db/schema";
import { calendarMonthBoundsUtc, dateKeysInclusiveUtc } from "@/lib/billing-utils";
import { requireOpenMeterForUsageReads } from "@/lib/openmeter/constants";
import { getAuthorizedProviderApp } from "@/lib/provider-apps";
import { queryOpenMeterAppDashboardUsage } from "@/lib/usage/query-openmeter";

export type BillingAppRow = {
  id: string;
  name: string;
  ownerId: string;
  ownerName: string | null;
  ownerEmail: string | null;
};

export type BillingUserUsageRow = {
  endUserId: string;
  externalUserId: string | null;
  userType: "system_managed" | "oidc_authorized" | "unknown";
  userLabel: string;
  identifier: string;
  requestCount: number;
  totalFeeWei: string;
  totalUnits: string;
  networkFeeUsdMicros?: string;
};

export type BillingPipelineModelSummary = {
  pipeline: string;
  modelId: string;
  requestCount: number;
  networkFeeUsdMicros: string;
  endUserBillableUsdMicros: string;
};

export type BillingAppUsageSummary = {
  app: BillingAppRow;
  requestCount: number;
  totalFeeWei: string;
  totalUnits: string;
  networkFeeUsdMicros: string;
  endUserBillableUsdMicros: string;
  byUser: BillingUserUsageRow[];
  byPipelineModel: BillingPipelineModelSummary[];
};

export function formatBillingWei(wei: string): string {
  if (!wei || !/^\d+$/.test(wei)) return "0";
  const value = BigInt(wei);
  if (value === 0n) return "0";
  const divisor = 10n ** 18n;
  const whole = value / divisor;
  const remainder = value % divisor;
  if (whole === 0n && remainder > 0n) return `${value.toString()} wei`;
  const fracStr = remainder.toString().padStart(18, "0").slice(0, 6);
  return `${whole}.${fracStr} ETH`;
}

export function formatBillingPeriod(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

function sortAppsForViewer(apps: BillingAppRow[], userId: string, isAdmin: boolean): BillingAppRow[] {
  const byName = (a: BillingAppRow, b: BillingAppRow) => a.name.localeCompare(b.name);
  if (!isAdmin) {
    return [...apps].sort(byName);
  }
  const owned = apps.filter((app) => app.ownerId === userId).sort(byName);
  const rest = apps.filter((app) => app.ownerId !== userId).sort(byName);
  return [...owned, ...rest];
}

function isTestUserOwner(app: BillingAppRow): boolean {
  return app.ownerName?.trim() === "Test User";
}

function sortAppUsageByMostUsed(appUsage: BillingAppUsageSummary[]): BillingAppUsageSummary[] {
  return [...appUsage].sort((a, b) => {
    const tierA = isTestUserOwner(a.app) ? 1 : 0;
    const tierB = isTestUserOwner(b.app) ? 1 : 0;
    if (tierA !== tierB) {
      return tierA - tierB;
    }

    if (b.requestCount !== a.requestCount) {
      return b.requestCount - a.requestCount;
    }

    const unitsA = BigInt(a.totalUnits);
    const unitsB = BigInt(b.totalUnits);
    if (unitsA !== unitsB) {
      return unitsB > unitsA ? 1 : -1;
    }

    const feeA = BigInt(a.totalFeeWei);
    const feeB = BigInt(b.totalFeeWei);
    if (feeA !== feeB) {
      return feeB > feeA ? 1 : -1;
    }

    return a.app.name.localeCompare(b.app.name);
  });
}

export type BillingUsageDashboardPayload = {
  scope: "all" | "single";
  userId: string;
  role: string | undefined;
  isAdmin: boolean;
  usageSource: "openmeter";
  cycle: { start: string; end: string };
  orderedApps: BillingAppRow[];
  appUsage: BillingAppUsageSummary[];
  chartData: { date: string; value: number }[];
  totalRequests: number;
  totalFeeWei: bigint;
  totalNetworkFeeUsdMicros: bigint;
  appsWithUsage: number;
};

export type BillingUsageDashboardResult =
  | { ok: false; reason: "no_session" }
  | { ok: false; reason: "forbidden" }
  | { ok: false; reason: "openmeter_unconfigured" }
  | { ok: true; data: BillingUsageDashboardPayload };

export async function getBillingUsageDashboardData(
  filterAppId?: string | null,
): Promise<BillingUsageDashboardResult> {
  const session = await getServerSession(authOptions);
  const sessionUser = session?.user as Record<string, unknown> | undefined;
  const userId = sessionUser?.id as string | undefined;
  const role = sessionUser?.role as string | undefined;
  const isAdmin = role === "admin";

  if (!userId) {
    return { ok: false, reason: "no_session" };
  }

  const appsQuery = db
    .select({
      id: developerApps.id,
      name: developerApps.name,
      ownerId: developerApps.ownerId,
      ownerName: users.name,
      ownerEmail: users.email,
    })
    .from(developerApps)
    .leftJoin(users, eq(developerApps.ownerId, users.id));

  let orderedApps: BillingAppRow[];
  let scope: "all" | "single";

  if (filterAppId) {
    const auth = await getAuthorizedProviderApp(filterAppId);
    if (!auth) {
      return { ok: false, reason: "forbidden" };
    }
    const rows = await appsQuery.where(eq(developerApps.id, auth.app.id)).limit(1);
    const row = rows[0];
    if (!row) {
      return { ok: false, reason: "forbidden" };
    }
    orderedApps = [row as BillingAppRow];
    scope = "single";
  } else {
    const visibleApps = (isAdmin
      ? await appsQuery
      : await appsQuery.where(eq(developerApps.ownerId, userId))) as BillingAppRow[];
    orderedApps = sortAppsForViewer(visibleApps, userId, isAdmin);
    scope = "all";
  }

  const cycleBounds = calendarMonthBoundsUtc(new Date());
  const cycle = { start: cycleBounds.start, end: cycleBounds.end };

  if (!requireOpenMeterForUsageReads()) {
    return { ok: false, reason: "openmeter_unconfigured" };
  }

  return buildOpenMeterBillingDashboard({
    scope,
    userId,
    role,
    isAdmin,
    cycle,
    cycleBounds,
    orderedApps,
  });
}

async function buildOpenMeterBillingDashboard(input: {
  scope: "all" | "single";
  userId: string;
  role: string | undefined;
  isAdmin: boolean;
  cycle: { start: string; end: string };
  cycleBounds: { start: string; end: string };
  orderedApps: BillingAppRow[];
}): Promise<BillingUsageDashboardResult> {
  const omResults = await Promise.all(
    input.orderedApps.map((app) =>
      queryOpenMeterAppDashboardUsage({
        clientId: app.id,
        startDate: input.cycle.start,
        endDate: input.cycle.end,
      }),
    ),
  );

  const requestsByDay = new Map<string, number>();

  const appUsage: BillingAppUsageSummary[] = sortAppUsageByMostUsed(
    input.orderedApps.map((app, index) => {
      const om = omResults[index];
      if (!om) {
        return {
          app,
          requestCount: 0,
          totalFeeWei: "0",
          totalUnits: "0",
          networkFeeUsdMicros: "0",
          endUserBillableUsdMicros: "0",
          byUser: [],
          byPipelineModel: [],
        };
      }

      for (const [day, count] of om.requestsByDay) {
        requestsByDay.set(day, (requestsByDay.get(day) ?? 0) + count);
      }

      let networkFeeUsdMicros = 0n;
      let requestCount = 0;
      for (const row of om.byUser) {
        networkFeeUsdMicros += BigInt(row.networkFeeUsdMicros);
        requestCount += row.requestCount;
      }

      const byUser: BillingUserUsageRow[] = [...om.byUser]
        .sort((a, b) => {
          if (b.requestCount !== a.requestCount) {
            return b.requestCount - a.requestCount;
          }
          const feeA = BigInt(a.networkFeeUsdMicros);
          const feeB = BigInt(b.networkFeeUsdMicros);
          if (feeA === feeB) return 0;
          return feeB > feeA ? 1 : -1;
        })
        .map((row) => ({
          endUserId: row.externalUserId,
          externalUserId: row.externalUserId,
          userType: "system_managed" as const,
          userLabel: row.externalUserId,
          identifier: row.externalUserId,
          requestCount: row.requestCount,
          totalFeeWei: "0",
          totalUnits: "0",
          networkFeeUsdMicros: row.networkFeeUsdMicros,
        }));

      return {
        app,
        requestCount,
        totalFeeWei: "0",
        totalUnits: "0",
        networkFeeUsdMicros: networkFeeUsdMicros.toString(),
        endUserBillableUsdMicros: networkFeeUsdMicros.toString(),
        byUser,
        byPipelineModel: om.byPipelineModel.map((pm) => ({
          pipeline: pm.pipeline,
          modelId: pm.modelId,
          requestCount: pm.requestCount,
          networkFeeUsdMicros: pm.networkFeeUsdMicros,
          endUserBillableUsdMicros: pm.networkFeeUsdMicros,
        })),
      };
    }),
  );

  const totalRequests = appUsage.reduce((sum, row) => sum + row.requestCount, 0);
  const totalNetworkFeeUsdMicros = appUsage.reduce(
    (sum, row) => sum + BigInt(row.networkFeeUsdMicros || "0"),
    0n,
  );
  const appsWithUsage = appUsage.filter((app) => app.requestCount > 0).length;
  const chartData: { date: string; value: number }[] = dateKeysInclusiveUtc(
    input.cycleBounds.start,
    input.cycleBounds.end,
  ).map((date) => ({
    date,
    value: requestsByDay.get(date) ?? 0,
  }));

  return {
    ok: true,
    data: {
      scope: input.scope,
      userId: input.userId,
      role: input.role,
      isAdmin: input.isAdmin,
      usageSource: "openmeter",
      cycle: { start: input.cycle.start, end: input.cycle.end },
      orderedApps: input.orderedApps,
      appUsage,
      chartData,
      totalRequests,
      totalFeeWei: 0n,
      totalNetworkFeeUsdMicros,
      appsWithUsage,
    },
  };
}
