import { and, eq } from "drizzle-orm";

import { db } from "@/db/index";
import { appUsers, developerApps, oidcClients, plans } from "@/db/schema";
import { calendarMonthBoundsUtc } from "@/lib/billing-utils";
import {
  applyWalletClassification,
  BALANCE_ENRICH_CONCURRENCY,
  BALANCE_ENRICH_USER_CAP,
  enrichByUserBalanceFields,
  emptyUserBalanceFields,
  isOwnerWalletExternalUserId,
  selectUsersForBalanceEnrichment,
  type EnrichableUserUsageRow,
} from "@/lib/billing-usage-balance-enrich";
import { isHostedAdminClientAvailable } from "@/lib/openmeter/admin-client";
import { buildOpenMeterCustomerKey } from "@/lib/openmeter/customer-key";
import { getSpendableAllowanceDetails } from "@/lib/openmeter/spendable-allowance";
import {
  getPrimaryOpenMeterSubscriptionForAppUser,
  resolveLocalPlanIdFromOpenMeterSubscription,
  type OpenMeterSubscriptionView,
} from "@/lib/openmeter/subscription-read";
import {
  isOwnerStarterPlanKey,
  OWNER_STARTER_PLAN_NAME,
} from "@/lib/openmeter/owner-starter-key";
import { buildExternalUserIdMatchKeys } from "@/lib/openmeter/usage-read";
import {
  queryOpenMeterAppDashboardUsage,
  queryOpenMeterUsage,
} from "@/lib/usage/query-openmeter";

type DeveloperApp = typeof developerApps.$inferSelect;

export type AppCustomerListRow = {
  id: string;
  externalUserId: string;
  email: string | null;
  status: string;
  role: string;
  createdAt: string;
  isOwnerWallet: boolean;
  requestCount: number;
  networkFeeUsdMicros: string;
  spendableUsdMicros: string | null;
  planRemainingUsdMicros: string | null;
  planGrantedUsdMicros: string | null;
  subscription: {
    id: string;
    status: string;
    planName: string | null;
    planId: string | null;
  } | null;
};

export type AppCustomersListPayload = {
  appId: string;
  publicClientId: string;
  appName: string;
  cycle: { start: string; end: string };
  customers: AppCustomerListRow[];
  balancesTruncated: boolean;
};

export type AppCustomerDetailPayload = {
  appId: string;
  publicClientId: string;
  appName: string;
  cycle: { start: string; end: string };
  customer: {
    id: string;
    externalUserId: string;
    email: string | null;
    status: string;
    role: string;
    createdAt: string;
    isOwnerWallet: boolean;
  };
  balance: {
    spendableUsdMicros: string | null;
    planGrantedUsdMicros: string | null;
    planRemainingUsdMicros: string | null;
    planConsumedUsdMicros: string | null;
    hasAccess: boolean | null;
  };
  subscription: {
    id: string;
    status: string;
    planId: string | null;
    planName: string | null;
    planType: string | null;
    openmeterPlanKey: string | null;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
  } | null;
  usage: {
    requestCount: number;
    networkFeeUsdMicros: string;
    byPipelineModel: Array<{
      pipeline: string;
      modelId: string;
      requestCount: number;
      networkFeeUsdMicros: string;
    }>;
  };
};

async function resolvePublicClientId(app: DeveloperApp): Promise<string> {
  if (!app.oidcClientId) {
    return app.id;
  }
  const rows = await db
    .select({ clientId: oidcClients.clientId })
    .from(oidcClients)
    .where(eq(oidcClients.id, app.oidcClientId))
    .limit(1);
  return rows[0]?.clientId?.trim() || app.id;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]!);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

/** Match meter groupBy.external_user_id variants to a provisioned app user id. */
export function matchUsageRowForExternalUser(
  usageByExternal: ReadonlyMap<
    string,
    { requestCount: number; networkFeeUsdMicros: string }
  >,
  publicClientId: string,
  externalUserId: string,
): { requestCount: number; networkFeeUsdMicros: string } | undefined {
  const direct = usageByExternal.get(externalUserId);
  if (direct) {
    return direct;
  }
  const compound = buildOpenMeterCustomerKey(publicClientId, externalUserId);
  const compoundHit = usageByExternal.get(compound);
  if (compoundHit) {
    return compoundHit;
  }
  const keys = buildExternalUserIdMatchKeys(externalUserId);
  keys.add(compound);
  for (const [meterId, row] of usageByExternal) {
    if (keys.has(meterId)) {
      return row;
    }
  }
  return undefined;
}

async function subscriptionSummaryFromOm(
  developerAppId: string,
  om: OpenMeterSubscriptionView,
): Promise<AppCustomerListRow["subscription"]> {
  const localPlanId = await resolveLocalPlanIdFromOpenMeterSubscription(
    developerAppId,
    om,
  );
  const planRows = localPlanId
    ? await db.select().from(plans).where(eq(plans.id, localPlanId)).limit(1)
    : [];
  const plan = planRows[0] ?? null;
  const isOwnerStarter = isOwnerStarterPlanKey(om.planKey);
  return {
    id: om.id,
    status: om.status,
    planId: plan?.id ?? null,
    planName: plan?.name ?? (isOwnerStarter ? OWNER_STARTER_PLAN_NAME : null),
  };
}

async function loadSubscriptionSummary(input: {
  developerAppId: string;
  publicClientId: string;
  externalUserId: string;
}): Promise<AppCustomerListRow["subscription"]> {
  if (!isHostedAdminClientAvailable()) {
    return null;
  }
  try {
    const om = await getPrimaryOpenMeterSubscriptionForAppUser({
      clientId: input.publicClientId,
      externalUserId: input.externalUserId,
    });
    if (!om) {
      return null;
    }
    return await subscriptionSummaryFromOm(input.developerAppId, om);
  } catch {
    return null;
  }
}

export async function getAppCustomersList(
  app: DeveloperApp,
): Promise<AppCustomersListPayload> {
  const publicClientId = await resolvePublicClientId(app);
  const cycle = calendarMonthBoundsUtc(new Date());

  const rows = await db
    .select()
    .from(appUsers)
    .where(eq(appUsers.clientId, app.id));

  const usageByExternal = new Map<
    string,
    { requestCount: number; networkFeeUsdMicros: string }
  >();
  if (isHostedAdminClientAvailable()) {
    try {
      const dashboard = await queryOpenMeterAppDashboardUsage({
        clientId: app.id,
        startDate: cycle.start,
        endDate: cycle.end,
      });
      for (const row of dashboard?.byUser ?? []) {
        usageByExternal.set(row.externalUserId, {
          requestCount: row.requestCount,
          networkFeeUsdMicros: row.networkFeeUsdMicros,
        });
      }
    } catch (err) {
      console.warn(
        "app-customers: usage query failed",
        app.id,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  let enrichable: EnrichableUserUsageRow[] = rows.map((row) => {
    const usage = matchUsageRowForExternalUser(
      usageByExternal,
      publicClientId,
      row.externalUserId,
    );
    return {
      endUserId: row.externalUserId,
      externalUserId: row.externalUserId,
      userLabel: row.email?.trim() || row.externalUserId,
      networkFeeUsdMicros: usage?.networkFeeUsdMicros ?? "0",
    };
  });
  enrichable = applyWalletClassification(
    enrichable,
    app.ownerId,
    publicClientId,
  );

  let balancesTruncated = false;
  if (isHostedAdminClientAvailable() && enrichable.length > 0) {
    const enriched = await enrichByUserBalanceFields({
      publicClientId,
      byUser: enrichable,
      cap: BALANCE_ENRICH_USER_CAP,
      concurrency: BALANCE_ENRICH_CONCURRENCY,
    });
    enrichable = enriched.byUser;
    balancesTruncated = enriched.balancesTruncated;
  } else {
    enrichable = enrichable.map((row) => ({
      ...row,
      ...emptyUserBalanceFields(),
    }));
  }

  const balanceById = new Map(
    enrichable.map((row) => [row.externalUserId ?? row.endUserId, row]),
  );

  const { selected: subTargets } = selectUsersForBalanceEnrichment(
    enrichable,
    BALANCE_ENRICH_USER_CAP,
  );
  const subResults = await mapWithConcurrency(
    subTargets,
    BALANCE_ENRICH_CONCURRENCY,
    async (row) => {
      const externalUserId = row.externalUserId ?? row.endUserId;
      const subscription = await loadSubscriptionSummary({
        developerAppId: app.id,
        publicClientId,
        externalUserId,
      });
      return { externalUserId, subscription };
    },
  );
  const subById = new Map(
    subResults.map((row) => [row.externalUserId, row.subscription]),
  );

  const customers: AppCustomerListRow[] = rows
    .map((row) => {
      const enriched = balanceById.get(row.externalUserId);
      const usage = matchUsageRowForExternalUser(
        usageByExternal,
        publicClientId,
        row.externalUserId,
      );
      return {
        id: row.id,
        externalUserId: row.externalUserId,
        email: row.email,
        status: row.status,
        role: row.role,
        createdAt: row.createdAt,
        isOwnerWallet: enriched?.isOwnerWallet === true,
        requestCount: usage?.requestCount ?? 0,
        networkFeeUsdMicros: usage?.networkFeeUsdMicros ?? "0",
        spendableUsdMicros: enriched?.spendableUsdMicros ?? null,
        planRemainingUsdMicros: enriched?.planRemainingUsdMicros ?? null,
        planGrantedUsdMicros: enriched?.planGrantedUsdMicros ?? null,
        subscription: subById.get(row.externalUserId) ?? null,
      };
    })
    .sort((a, b) => {
      const feeA = BigInt(a.networkFeeUsdMicros);
      const feeB = BigInt(b.networkFeeUsdMicros);
      if (feeA !== feeB) {
        return feeB > feeA ? 1 : -1;
      }
      return a.externalUserId.localeCompare(b.externalUserId);
    });

  return {
    appId: app.id,
    publicClientId,
    appName: app.name,
    cycle,
    customers,
    balancesTruncated,
  };
}

export async function getAppCustomerDetail(
  app: DeveloperApp,
  externalUserIdRaw: string,
): Promise<AppCustomerDetailPayload | null> {
  const externalUserId = externalUserIdRaw.trim();
  if (!externalUserId) {
    return null;
  }

  const publicClientId = await resolvePublicClientId(app);
  const cycle = calendarMonthBoundsUtc(new Date());

  const userRows = await db
    .select()
    .from(appUsers)
    .where(
      and(
        eq(appUsers.clientId, app.id),
        eq(appUsers.externalUserId, externalUserId),
      ),
    )
    .limit(1);
  const user = userRows[0];
  if (!user) {
    return null;
  }

  const isOwnerWallet = isOwnerWalletExternalUserId(
    app.ownerId,
    user.externalUserId,
    publicClientId,
  );

  let balance: AppCustomerDetailPayload["balance"] = {
    spendableUsdMicros: null,
    planGrantedUsdMicros: null,
    planRemainingUsdMicros: null,
    planConsumedUsdMicros: null,
    hasAccess: null,
  };
  if (isHostedAdminClientAvailable()) {
    try {
      const details = await getSpendableAllowanceDetails({
        clientId: publicClientId,
        externalUserId,
      });
      if (details) {
        const granted = BigInt(details.grantedUsdMicros);
        const remaining = BigInt(details.remainingPlanDiscountUsdMicros);
        const consumed = granted > remaining ? granted - remaining : 0n;
        balance = {
          spendableUsdMicros: details.spendableUsdMicros,
          planGrantedUsdMicros: details.grantedUsdMicros,
          planRemainingUsdMicros: details.remainingPlanDiscountUsdMicros,
          planConsumedUsdMicros: consumed.toString(),
          hasAccess: BigInt(details.spendableUsdMicros) > 0n,
        };
      }
    } catch (err) {
      console.warn(
        "app-customers: balance lookup failed",
        publicClientId,
        externalUserId,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  let subscription: AppCustomerDetailPayload["subscription"] = null;
  if (isHostedAdminClientAvailable()) {
    try {
      const om = await getPrimaryOpenMeterSubscriptionForAppUser({
        clientId: publicClientId,
        externalUserId,
      });
      if (om) {
        const localPlanId = await resolveLocalPlanIdFromOpenMeterSubscription(
          app.id,
          om,
        );
        const planRows = localPlanId
          ? await db.select().from(plans).where(eq(plans.id, localPlanId)).limit(1)
          : [];
        const plan = planRows[0] ?? null;
        const isOwnerStarter = isOwnerStarterPlanKey(om.planKey);
        subscription = {
          id: om.id,
          status: om.status,
          planId: plan?.id ?? null,
          planName:
            plan?.name ?? (isOwnerStarter ? OWNER_STARTER_PLAN_NAME : null),
          planType: plan?.type ?? (isOwnerStarter ? "free" : null),
          openmeterPlanKey: om.planKey,
          currentPeriodStart: om.activeFrom,
          currentPeriodEnd: om.activeTo,
        };
      }
    } catch (err) {
      console.warn(
        "app-customers: subscription lookup failed",
        publicClientId,
        externalUserId,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  let usage: AppCustomerDetailPayload["usage"] = {
    requestCount: 0,
    networkFeeUsdMicros: "0",
    byPipelineModel: [],
  };
  if (isHostedAdminClientAvailable()) {
    try {
      const [userRowsOm, dashboard] = await Promise.all([
        queryOpenMeterUsage({
          clientId: app.id,
          startDate: cycle.start,
          endDate: cycle.end,
          externalUserId,
        }),
        queryOpenMeterAppDashboardUsage({
          clientId: app.id,
          startDate: cycle.start,
          endDate: cycle.end,
          externalUserId,
        }),
      ]);
      const totalRequests = userRowsOm.reduce((sum, row) => sum + row.requestCount, 0);
      const totalFee = userRowsOm.reduce(
        (sum, row) => sum + BigInt(row.networkFeeUsdMicros),
        0n,
      );
      usage = {
        requestCount: totalRequests,
        networkFeeUsdMicros: totalFee.toString(),
        byPipelineModel: (dashboard?.byPipelineModel ?? []).map((row) => ({
          pipeline: row.pipeline,
          modelId: row.modelId,
          requestCount: row.requestCount,
          networkFeeUsdMicros: row.networkFeeUsdMicros,
        })),
      };
    } catch (err) {
      console.warn(
        "app-customers: detail usage query failed",
        publicClientId,
        externalUserId,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return {
    appId: app.id,
    publicClientId,
    appName: app.name,
    cycle,
    customer: {
      id: user.id,
      externalUserId: user.externalUserId,
      email: user.email,
      status: user.status,
      role: user.role,
      createdAt: user.createdAt,
      isOwnerWallet,
    },
    balance,
    subscription,
    usage,
  };
}
