import { getServerSession } from "next-auth";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { db } from "@/db/index";
import { appUsers, developerApps, usageBillingEvents, usageRecords, users } from "@/db/schema";
import { getAuthorizedProviderApp } from "@/domains/developer-apps/runtime/provider-access";
import { authOptions } from "@/platform/auth/next-auth-options";
import { calendarMonthBoundsUtc, dateKeysInclusiveUtc } from "@/shared/utils/billing-utils";

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

function dateKeyFromIso(iso: string): string {
  return iso.slice(0, 10);
}

function classifyUsageUser(endUserId: string, externalUserId: string | null): {
  userType: "system_managed" | "oidc_authorized" | "unknown";
  userLabel: string;
  identifier: string;
} {
  if (externalUserId) {
    return {
      userType: "system_managed",
      userLabel: externalUserId,
      identifier: endUserId,
    };
  }
  if (endUserId !== "unknown") {
    return {
      userType: "oidc_authorized",
      userLabel: "OIDC user (not provisioned)",
      identifier: endUserId,
    };
  }
  return {
    userType: "unknown",
    userLabel: "Unknown / unscoped",
    identifier: "unknown",
  };
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
  cycle: { start: string; end: string };
  orderedApps: BillingAppRow[];
  appUsage: BillingAppUsageSummary[];
  chartData: { date: string; value: number }[];
  totalRequests: number;
  totalFeeWei: bigint;
  appsWithUsage: number;
};

export type BillingUsageDashboardResult =
  | { ok: false; reason: "no_session" }
  | { ok: false; reason: "forbidden" }
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

  const appIds = orderedApps.map((app) => app.id);
  const cycleBounds = calendarMonthBoundsUtc(new Date());
  const cycle = { start: cycleBounds.start, end: cycleBounds.end };

  const usageRows =
    appIds.length > 0
      ? await db
          .select()
          .from(usageRecords)
          .where(
            and(
              inArray(usageRecords.clientId, appIds),
              gte(usageRecords.createdAt, cycleBounds.start),
              lte(usageRecords.createdAt, cycleBounds.end),
            ),
          )
      : [];

  const appUserRows =
    appIds.length > 0
      ? await db
          .select({
            id: appUsers.id,
            clientId: appUsers.clientId,
            externalUserId: appUsers.externalUserId,
          })
          .from(appUsers)
          .where(inArray(appUsers.clientId, appIds))
      : [];

  const usageRecordIds = usageRows.map((r) => r.id).filter(Boolean);
  const billingEventRows =
    usageRecordIds.length > 0
      ? await db
          .select()
          .from(usageBillingEvents)
          .where(inArray(usageBillingEvents.usageRecordId, usageRecordIds))
      : [];

  const eventByUsageRecord = new Map(billingEventRows.map((e) => [e.usageRecordId, e]));
  const externalUserIdByAppUser = new Map(
    appUserRows.map((row) => [`${row.clientId}:${row.id}`, row.externalUserId]),
  );

  const summaryByApp = new Map<
    string,
    {
      requestCount: number;
      totalFeeWei: bigint;
      totalUnits: bigint;
      networkFeeUsdMicros: bigint;
      endUserBillableUsdMicros: bigint;
      byUser: Map<string, { requestCount: number; totalFeeWei: bigint; totalUnits: bigint }>;
      byPipelineModel: Map<
        string,
        {
          pipeline: string;
          modelId: string;
          requestCount: number;
          networkFeeUsdMicros: bigint;
          endUserBillableUsdMicros: bigint;
        }
      >;
    }
  >();

  for (const app of orderedApps) {
    summaryByApp.set(app.id, {
      requestCount: 0,
      totalFeeWei: 0n,
      totalUnits: 0n,
      networkFeeUsdMicros: 0n,
      endUserBillableUsdMicros: 0n,
      byUser: new Map(),
      byPipelineModel: new Map(),
    });
  }

  for (const row of usageRows) {
    const appSummary = summaryByApp.get(row.clientId);
    if (!appSummary) continue;

    appSummary.requestCount += 1;
    appSummary.totalFeeWei += BigInt(row.fee || "0");
    appSummary.totalUnits += BigInt(row.units || "0");

    const billingEvent = eventByUsageRecord.get(row.id);
    if (billingEvent) {
      appSummary.networkFeeUsdMicros += BigInt(billingEvent.networkFeeUsdMicros);
      appSummary.endUserBillableUsdMicros += BigInt(billingEvent.endUserBillableUsdMicros);

      const pmKey = `${billingEvent.pipeline}|${billingEvent.modelId}`;
      const existing = appSummary.byPipelineModel.get(pmKey) || {
        pipeline: billingEvent.pipeline,
        modelId: billingEvent.modelId,
        requestCount: 0,
        networkFeeUsdMicros: 0n,
        endUserBillableUsdMicros: 0n,
      };
      existing.requestCount += 1;
      existing.networkFeeUsdMicros += BigInt(billingEvent.networkFeeUsdMicros);
      existing.endUserBillableUsdMicros += BigInt(billingEvent.endUserBillableUsdMicros);
      appSummary.byPipelineModel.set(pmKey, existing);
    }

    const endUserId = row.userId || "unknown";
    const userSummary = appSummary.byUser.get(endUserId) || {
      requestCount: 0,
      totalFeeWei: 0n,
      totalUnits: 0n,
    };
    userSummary.requestCount += 1;
    userSummary.totalFeeWei += BigInt(row.fee || "0");
    userSummary.totalUnits += BigInt(row.units || "0");
    appSummary.byUser.set(endUserId, userSummary);
  }

  const appUsage: BillingAppUsageSummary[] = sortAppUsageByMostUsed(
    orderedApps.map((app) => {
      const summary = summaryByApp.get(app.id)!;
      const byUser: BillingUserUsageRow[] = [...summary.byUser.entries()]
        .map(([endUserId, userSummary]) => {
          const externalUserId =
            endUserId === "unknown"
              ? null
              : externalUserIdByAppUser.get(`${app.id}:${endUserId}`) || null;
          const identity = classifyUsageUser(endUserId, externalUserId);
          return {
            endUserId,
            externalUserId,
            userType: identity.userType,
            userLabel: identity.userLabel,
            identifier: identity.identifier,
            requestCount: userSummary.requestCount,
            totalFeeWei: userSummary.totalFeeWei.toString(),
            totalUnits: userSummary.totalUnits.toString(),
          };
        })
        .sort((a, b) => {
          if (b.requestCount !== a.requestCount) {
            return b.requestCount - a.requestCount;
          }
          const feeA = BigInt(a.totalFeeWei);
          const feeB = BigInt(b.totalFeeWei);
          if (feeA === feeB) return 0;
          return feeB > feeA ? 1 : -1;
        });

      return {
        app,
        requestCount: summary.requestCount,
        totalFeeWei: summary.totalFeeWei.toString(),
        totalUnits: summary.totalUnits.toString(),
        networkFeeUsdMicros: summary.networkFeeUsdMicros.toString(),
        endUserBillableUsdMicros: summary.endUserBillableUsdMicros.toString(),
        byUser,
        byPipelineModel: [...summary.byPipelineModel.values()].map((pm) => ({
          pipeline: pm.pipeline,
          modelId: pm.modelId,
          requestCount: pm.requestCount,
          networkFeeUsdMicros: pm.networkFeeUsdMicros.toString(),
          endUserBillableUsdMicros: pm.endUserBillableUsdMicros.toString(),
        })),
      };
    }),
  );

  const totalRequests = appUsage.reduce((sum, row) => sum + row.requestCount, 0);
  const totalFeeWei = appUsage.reduce(
    (sum, row) => sum + BigInt(row.totalFeeWei || "0"),
    0n,
  );
  const appsWithUsage = appUsage.filter((app) => app.requestCount > 0).length;
  const requestsByDay = new Map<string, number>();
  for (const row of usageRows) {
    const day = dateKeyFromIso(row.createdAt);
    requestsByDay.set(day, (requestsByDay.get(day) ?? 0) + 1);
  }
  const chartData: { date: string; value: number }[] = dateKeysInclusiveUtc(
    cycleBounds.start,
    cycleBounds.end,
  ).map((date) => ({
    date,
    value: requestsByDay.get(date) ?? 0,
  }));

  return {
    ok: true,
    data: {
      scope,
      userId,
      role,
      isAdmin,
      cycle: { start: cycle.start, end: cycle.end },
      orderedApps,
      appUsage,
      chartData,
      totalRequests,
      totalFeeWei,
      appsWithUsage,
    },
  };
}
