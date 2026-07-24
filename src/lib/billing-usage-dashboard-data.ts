import { getServerSession } from "next-auth";
import { eq, inArray, or } from "drizzle-orm";
import { authOptions } from "@/lib/next-auth-options";
import { db } from "@/db/index";
import { developerApps, oidcClients, providerAdmins, users } from "@/db/schema";
import { calendarMonthBoundsUtc, dateKeysInclusiveUtc } from "@/lib/billing-utils";
import { requireOpenMeterForUsageReads } from "@/lib/openmeter/constants";
import {
  listOwnerActiveSubscriptions,
  type OwnerBillingSubscriptionRow,
} from "@/lib/owner-billing-data";
import { getAuthorizedProviderApp } from "@/lib/provider-apps";
import {
  queryOpenMeterAppDashboardUsage,
  type OpenMeterAppDashboardUsage,
} from "@/lib/usage/query-openmeter";

export type BillingAppRow = {
  id: string;
  name: string;
  ownerId: string;
  ownerName: string | null;
  ownerEmail: string | null;
  /**
   * Public OIDC client_id — same value as UserAppSummary.id / apps list selection.
   * Chart series and client-side filters must use this, not developer_apps.id
   * (those can differ for legacy apps).
   */
  publicClientId: string;
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
  byPipelineModel: BillingPipelineModelSummary[];
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

export { formatBillingPeriod, formatBillingWei } from "@/lib/billing-format";

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

export type BillingChartSeries = {
  appId: string;
  appName: string;
  /** Display label: pipeline capability + model/constraint (e.g. `byoc / transcode/ffmpeg`). */
  jobType: string;
  totalRequests: number;
  points: { date: string; value: number }[];
};

/** Chart legend label from OpenMeter pipeline + model_id (signer constraint). */
export function formatUsageJobTypeLabel(pipeline: string, modelId: string): string {
  const pipe = (pipeline || "unknown").trim() || "unknown";
  const model = (modelId || "").trim();
  if (!model || model === "unknown") return pipe;
  const shortModel = model.length > 40 ? `${model.slice(0, 38)}…` : model;
  return `${pipe} / ${shortModel}`;
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
  chartSeries: BillingChartSeries[];
  totalRequests: number;
  totalFeeWei: bigint;
  totalNetworkFeeUsdMicros: bigint;
  appsWithUsage: number;
  /** Viewer's active subscriptions (discount progress); empty when none / unavailable. */
  activeSubscriptions: OwnerBillingSubscriptionRow[];
};

export type BillingUsageDashboardResult =
  | { ok: false; reason: "no_session" }
  | { ok: false; reason: "forbidden" }
  | { ok: false; reason: "openmeter_unconfigured" }
  | { ok: true; data: BillingUsageDashboardPayload };

export async function getBillingUsageDashboardData(
  filterAppId?: string | null,
  options?: { ownAppsOnly?: boolean },
): Promise<BillingUsageDashboardResult> {
  const session = await getServerSession(authOptions);
  const sessionUser = session?.user as Record<string, unknown> | undefined;
  const userId = sessionUser?.id as string | undefined;
  const role = sessionUser?.role as string | undefined;
  const isAdmin = role === "admin";
  const ownAppsOnly = options?.ownAppsOnly === true;

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
      publicClientId: oidcClients.clientId,
    })
    .from(developerApps)
    .leftJoin(users, eq(developerApps.ownerId, users.id))
    .leftJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id));

  let orderedApps: BillingAppRow[];
  let scope: "all" | "single";

  const toBillingApp = (row: {
    id: string;
    name: string;
    ownerId: string;
    ownerName: string | null;
    ownerEmail: string | null;
    publicClientId: string | null;
  }): BillingAppRow => ({
    id: row.id,
    name: row.name,
    ownerId: row.ownerId,
    ownerName: row.ownerName,
    ownerEmail: row.ownerEmail,
    // Prefer public OIDC client_id; fall back to developer_apps.id when unset.
    publicClientId: row.publicClientId?.trim() || row.id,
  });

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
    orderedApps = [toBillingApp(row)];
    scope = "single";
  } else if (isAdmin && !ownAppsOnly) {
    const visibleApps = (await appsQuery).map(toBillingApp);
    orderedApps = sortAppsForViewer(visibleApps, userId, true);
    scope = "all";
  } else {
    // Match My Apps / listUserAccessibleApps: owned + administered.
    const memberships = await db
      .select({ clientId: providerAdmins.clientId })
      .from(providerAdmins)
      .where(eq(providerAdmins.userId, userId));
    const memberIds = memberships.map((m) => m.clientId);
    const ownOrAdmin =
      memberIds.length === 0
        ? eq(developerApps.ownerId, userId)
        : or(eq(developerApps.ownerId, userId), inArray(developerApps.id, memberIds));
    const visibleApps = (await appsQuery.where(ownOrAdmin!)).map(toBillingApp);
    orderedApps = sortAppsForViewer(visibleApps, userId, false);
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

/** Max apps queried in parallel against Konnect (each app fires 4 meter queries). */
const DASHBOARD_APP_QUERY_PAGE_SIZE = 3;

function chunkApps<T>(items: T[], size: number): T[][] {
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    pages.push(items.slice(i, i + size));
  }
  return pages;
}

async function queryDashboardUsageForApp(
  app: BillingAppRow,
  cycle: { start: string; end: string },
): Promise<OpenMeterAppDashboardUsage | null> {
  try {
    return await queryOpenMeterAppDashboardUsage({
      clientId: app.id,
      startDate: cycle.start,
      endDate: cycle.end,
    });
  } catch (err) {
    console.warn(
      "billing-usage-dashboard: OpenMeter query failed",
      app.id,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

async function queryDashboardUsagePaged(
  apps: BillingAppRow[],
  cycle: { start: string; end: string },
): Promise<Array<OpenMeterAppDashboardUsage | null>> {
  const results: Array<OpenMeterAppDashboardUsage | null> = [];
  for (const page of chunkApps(apps, DASHBOARD_APP_QUERY_PAGE_SIZE)) {
    const pageResults = await Promise.all(
      page.map((app) => queryDashboardUsageForApp(app, cycle)),
    );
    results.push(...pageResults);
  }
  return results;
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
  const [omResults, activeSubscriptions] = await Promise.all([
    queryDashboardUsagePaged(input.orderedApps, input.cycle),
    listOwnerActiveSubscriptions(input.userId).catch((err) => {
      console.warn(
        "billing-usage-dashboard: subscription summary failed",
        err instanceof Error ? err.message : String(err),
      );
      return [] as OwnerBillingSubscriptionRow[];
    }),
  ]);

  const requestsByDay = new Map<string, number>();
  /** appId|pipeline|modelId → day → count */
  const seriesDayCounts = new Map<string, Map<string, number>>();
  const seriesMeta = new Map<string, { appId: string; appName: string; jobType: string }>();

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

      for (const row of om.byDailyPipeline ?? []) {
        const pipeline = row.pipeline || "unknown";
        const modelId = row.modelId || "unknown";
        const jobType = formatUsageJobTypeLabel(pipeline, modelId);
        const chartAppId = app.publicClientId;
        // Key by both dimensions so distinct constraints do not collapse under one pipeline.
        const seriesKey = `${chartAppId}|${pipeline}|${modelId}`;
        if (!seriesMeta.has(seriesKey)) {
          seriesMeta.set(seriesKey, {
            appId: chartAppId,
            appName: app.name,
            jobType,
          });
        }
        const dayMap = seriesDayCounts.get(seriesKey) ?? new Map<string, number>();
        dayMap.set(row.date, (dayMap.get(row.date) ?? 0) + row.requestCount);
        seriesDayCounts.set(seriesKey, dayMap);
      }

      let networkFeeUsdMicros = 0n;
      let requestCount = 0;
      for (const row of om.byUser) {
        networkFeeUsdMicros += BigInt(row.networkFeeUsdMicros);
        requestCount += row.requestCount;
      }

      const byUserPipelineModel = new Map<string, BillingPipelineModelSummary[]>();
      for (const row of om.byUserPipelineModel ?? []) {
        const list = byUserPipelineModel.get(row.externalUserId) ?? [];
        list.push({
          pipeline: row.pipeline,
          modelId: row.modelId,
          requestCount: row.requestCount,
          networkFeeUsdMicros: row.networkFeeUsdMicros,
          endUserBillableUsdMicros: row.networkFeeUsdMicros,
        });
        byUserPipelineModel.set(row.externalUserId, list);
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
          byPipelineModel: [...(byUserPipelineModel.get(row.externalUserId) ?? [])].sort(
            (a, b) => {
              if (b.requestCount !== a.requestCount) {
                return b.requestCount - a.requestCount;
              }
              const feeA = BigInt(a.networkFeeUsdMicros);
              const feeB = BigInt(b.networkFeeUsdMicros);
              if (feeA === feeB) return 0;
              return feeB > feeA ? 1 : -1;
            },
          ),
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
  const todayKeyUtc = new Date().toISOString().slice(0, 10);
  const dateKeys = dateKeysInclusiveUtc(input.cycleBounds.start, input.cycleBounds.end).filter(
    (date) => date <= todayKeyUtc,
  );
  const chartData: { date: string; value: number }[] = dateKeys.map((date) => ({
    date,
    value: requestsByDay.get(date) ?? 0,
  }));

  const chartSeries: BillingChartSeries[] = [...seriesMeta.entries()]
    .map(([seriesKey, meta]) => {
      const dayMap = seriesDayCounts.get(seriesKey) ?? new Map<string, number>();
      const points = dateKeys.map((date) => ({
        date,
        value: dayMap.get(date) ?? 0,
      }));
      const totalRequests = points.reduce((sum, point) => sum + point.value, 0);
      return {
        appId: meta.appId,
        appName: meta.appName,
        jobType: meta.jobType,
        totalRequests,
        points,
      };
    })
    .filter((series) => series.totalRequests > 0)
    .sort((a, b) => {
      if (b.totalRequests !== a.totalRequests) return b.totalRequests - a.totalRequests;
      const appCmp = a.appName.localeCompare(b.appName);
      if (appCmp !== 0) return appCmp;
      return a.jobType.localeCompare(b.jobType);
    });

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
      chartSeries,
      totalRequests,
      totalFeeWei: 0n,
      totalNetworkFeeUsdMicros,
      appsWithUsage,
      activeSubscriptions,
    },
  };
}
