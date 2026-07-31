import { getServerSession } from "next-auth";
import { eq, inArray, or } from "drizzle-orm";
import { authOptions } from "@/lib/next-auth-options";
import { db } from "@/db/index";
import { developerApps, oidcClients, providerAdmins, users } from "@/db/schema";
import { calendarMonthBoundsUtc, dateKeysInclusiveUtc } from "@/lib/billing-utils";
import { requireOpenMeterForUsageReads } from "@/lib/openmeter/constants";
import { getOwnerPrepaidCreditBalance } from "@/lib/openmeter/credit-allowance-summary";
import {
  listOwnerPaymentMethods,
  type OwnerPaymentMethodListItem,
} from "@/lib/openmeter/owner-payment-method";
import {
  listOwnerActiveSubscriptions,
  type OwnerBillingSubscriptionRow,
} from "@/lib/owner-billing-data";
import {
  getProviderApp,
  isProviderAdmin,
} from "@/lib/provider-apps";
import {
  queryOpenMeterAppDashboardUsage,
  type OpenMeterAppDashboardUsage,
} from "@/lib/usage/query-openmeter";
import {
  loadPlatformDefaultBillingApp,
  viewerHasAppUserMembership,
} from "@/lib/viewer-usage-clients";
import { PLATFORM_DEFAULT_USAGE_DISPLAY_NAME } from "@/lib/platform-default-labels";

export type BillingUsageKind = "tenant" | "personal";

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
  /**
   * `tenant` = full app aggregate (owned/administered apps, or admin All Usage).
   * `personal` = subject-scoped Explorer / network-key usage on the platform default.
   */
  usageKind: BillingUsageKind;
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
  /** Same days as `chartSeries`, split by app × identity instead of app × pipeline/model. */
  chartSeriesByIdentity: BillingChartSeries[];
  totalRequests: number;
  totalFeeWei: bigint;
  totalNetworkFeeUsdMicros: bigint;
  appsWithUsage: number;
  /** Viewer's active subscriptions (discount progress); empty when none / unavailable. */
  activeSubscriptions: OwnerBillingSubscriptionRow[];
  /**
   * Remaining prepaid credit balance (USD micros) for the cost waterfall.
   * Null when unavailable — the waterfall then shows no credit headroom.
   */
  creditBalanceUsdMicros: string | null;
  /** Default Stripe payment method on the owner wallet, if any. */
  defaultPaymentMethod: Pick<
    OwnerPaymentMethodListItem,
    "brand" | "last4"
  > | null;
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

  if (!userId) {
    return { ok: false, reason: "no_session" };
  }

  return getBillingUsageDashboardDataForUser(userId, role, filterAppId, options);
}

type BillingAppQueryRow = {
  id: string;
  name: string;
  ownerId: string;
  ownerName: string | null;
  ownerEmail: string | null;
  publicClientId: string | null;
};

function billingAppsQuery() {
  return db
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
}

function toBillingApp(
  row: BillingAppQueryRow,
  usageKind: BillingUsageKind = "tenant",
): BillingAppRow {
  return {
    id: row.id,
    name: usageKind === "personal" ? PLATFORM_DEFAULT_USAGE_DISPLAY_NAME : row.name,
    ownerId: row.ownerId,
    ownerName: row.ownerName,
    ownerEmail: row.ownerEmail,
    // Prefer public OIDC client_id; fall back to developer_apps.id when unset.
    publicClientId: row.publicClientId?.trim() || row.id,
    usageKind,
  };
}

/** Single-app scope; null when the viewer may not see it. */
async function resolveFilteredApp(
  filterAppId: string,
  userId: string,
  isAdmin: boolean,
): Promise<BillingAppRow[] | null> {
  const app = await getProviderApp(filterAppId);
  if (!app) return null;

  const mayView =
    isAdmin || app.ownerId === userId || (await isProviderAdmin(userId, app.id));
  if (!mayView) return null;

  const rows = await billingAppsQuery().where(eq(developerApps.id, app.id)).limit(1);
  const row = rows[0];
  return row ? [toBillingApp(row)] : null;
}

async function resolveAllApps(userId: string): Promise<BillingAppRow[]> {
  const visibleApps = (await billingAppsQuery()).map((row) => toBillingApp(row));
  return sortAppsForViewer(visibleApps, userId, true);
}

/**
 * Match My Apps: owned + administered, then add subject-scoped personal
 * network usage on the platform default (never full-tenant for that app).
 */
async function resolveViewerApps(userId: string): Promise<BillingAppRow[]> {
  const memberships = await db
    .select({ clientId: providerAdmins.clientId })
    .from(providerAdmins)
    .where(eq(providerAdmins.userId, userId));
  const memberIds = memberships.map((m) => m.clientId);
  const ownOrAdmin =
    memberIds.length === 0
      ? eq(developerApps.ownerId, userId)
      : or(eq(developerApps.ownerId, userId), inArray(developerApps.id, memberIds));

  const [visibleAppRows, defaultApp] = await Promise.all([
    billingAppsQuery().where(ownOrAdmin!),
    loadPlatformDefaultBillingApp(),
  ]);
  const visibleApps = visibleAppRows.map((row) => toBillingApp(row));

  if (!defaultApp) {
    return sortAppsForViewer(visibleApps, userId, false);
  }

  const tenantApps = visibleApps.filter(
    (app) =>
      app.id !== defaultApp.id && app.publicClientId !== defaultApp.publicClientId,
  );
  const sortedTenantApps = sortAppsForViewer(tenantApps, userId, false);

  const isMember = await viewerHasAppUserMembership(
    userId,
    defaultApp.publicClientId,
  );
  return isMember
    ? [...sortedTenantApps, toBillingApp(defaultApp, "personal")]
    : sortedTenantApps;
}

/** Session-free entry point for tests and callers that already resolved the viewer. */
export async function getBillingUsageDashboardDataForUser(
  userId: string,
  role: string | undefined,
  filterAppId?: string | null,
  options?: { ownAppsOnly?: boolean },
): Promise<BillingUsageDashboardResult> {
  const isAdmin = role === "admin";
  const ownAppsOnly = options?.ownAppsOnly === true;

  let orderedApps: BillingAppRow[];
  let scope: "all" | "single";

  if (filterAppId) {
    const filtered = await resolveFilteredApp(filterAppId, userId, isAdmin);
    if (!filtered) {
      return { ok: false, reason: "forbidden" };
    }
    orderedApps = filtered;
    scope = "single";
  } else {
    orderedApps =
      isAdmin && !ownAppsOnly
        ? await resolveAllApps(userId)
        : await resolveViewerApps(userId);
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
  viewerUserId: string,
): Promise<OpenMeterAppDashboardUsage | null> {
  try {
    return await queryOpenMeterAppDashboardUsage({
      clientId: app.id,
      startDate: cycle.start,
      endDate: cycle.end,
      externalUserId: app.usageKind === "personal" ? viewerUserId : null,
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
  viewerUserId: string,
): Promise<Array<OpenMeterAppDashboardUsage | null>> {
  const results: Array<OpenMeterAppDashboardUsage | null> = [];
  for (const page of chunkApps(apps, DASHBOARD_APP_QUERY_PAGE_SIZE)) {
    const pageResults = await Promise.all(
      page.map((app) => queryDashboardUsageForApp(app, cycle, viewerUserId)),
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
  const [omResults, activeSubscriptions, creditAllowance, paymentMethods] =
    await Promise.all([
      queryDashboardUsagePaged(input.orderedApps, input.cycle, input.userId),
      listOwnerActiveSubscriptions(input.userId).catch((err) => {
        console.warn(
          "billing-usage-dashboard: subscription summary failed",
          err instanceof Error ? err.message : String(err),
        );
        return [] as OwnerBillingSubscriptionRow[];
      }),
      getOwnerPrepaidCreditBalance(input.userId).catch((err) => {
        console.warn(
          "billing-usage-dashboard: prepaid credit balance failed",
          err instanceof Error ? err.message : String(err),
        );
        return null;
      }),
      listOwnerPaymentMethods(input.userId).catch((err) => {
        console.warn(
          "billing-usage-dashboard: payment method lookup failed",
          err instanceof Error ? err.message : String(err),
        );
        return [] as OwnerPaymentMethodListItem[];
      }),
    ]);
  const requestsByDay = new Map<string, number>();
  /** appId|pipeline|modelId → day → count */
  const seriesDayCounts = new Map<string, Map<string, number>>();
  const seriesMeta = new Map<string, { appId: string; appName: string; jobType: string }>();
  /** appId|externalUserId → day → count */
  const identitySeriesDayCounts = new Map<string, Map<string, number>>();
  const identitySeriesMeta = new Map<
    string,
    { appId: string; appName: string; jobType: string }
  >();

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

      for (const row of om.byDailyUser ?? []) {
        const chartAppId = app.publicClientId;
        const seriesKey = `${chartAppId}|${row.externalUserId}`;
        if (!identitySeriesMeta.has(seriesKey)) {
          identitySeriesMeta.set(seriesKey, {
            appId: chartAppId,
            appName: app.name,
            jobType: row.externalUserId,
          });
        }
        const dayMap =
          identitySeriesDayCounts.get(seriesKey) ?? new Map<string, number>();
        dayMap.set(row.date, (dayMap.get(row.date) ?? 0) + row.requestCount);
        identitySeriesDayCounts.set(seriesKey, dayMap);
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

  const buildChartSeries = (
    meta: Map<string, { appId: string; appName: string; jobType: string }>,
    dayCounts: Map<string, Map<string, number>>,
  ): BillingChartSeries[] =>
    [...meta.entries()]
      .map(([seriesKey, seriesMetaEntry]) => {
        const dayMap = dayCounts.get(seriesKey) ?? new Map<string, number>();
        const points = dateKeys.map((date) => ({
          date,
          value: dayMap.get(date) ?? 0,
        }));
        const totalRequests = points.reduce((sum, point) => sum + point.value, 0);
        return {
          appId: seriesMetaEntry.appId,
          appName: seriesMetaEntry.appName,
          jobType: seriesMetaEntry.jobType,
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

  const chartSeries = buildChartSeries(seriesMeta, seriesDayCounts);
  const chartSeriesByIdentity = buildChartSeries(
    identitySeriesMeta,
    identitySeriesDayCounts,
  );

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
      chartSeriesByIdentity,
      totalRequests,
      totalFeeWei: 0n,
      totalNetworkFeeUsdMicros,
      appsWithUsage,
      activeSubscriptions,
      creditBalanceUsdMicros: creditAllowance?.balanceUsdMicros ?? null,
      defaultPaymentMethod: (() => {
        const method =
          paymentMethods.find((item) => item.isDefault) ?? paymentMethods[0];
        if (!method) return null;
        return { brand: method.brand, last4: method.last4 };
      })(),
    },
  };
}
