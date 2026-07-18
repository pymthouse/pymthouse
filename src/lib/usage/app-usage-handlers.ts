import { NextResponse } from "next/server";

import { authenticateAppClient } from "@/lib/auth";
import {
  estimateEndUserBillableMicros,
  loadActiveRetailRatesForApp,
  resolveRetailRateForUsage,
} from "@/lib/billing/retail-usage";
import { requireExternalUserId } from "@/lib/external-user-id";
import { requireOpenMeterForUsageReads } from "@/lib/openmeter/constants";
import { getTrialCreditBalance } from "@/lib/openmeter/entitlements";
import { getAuthorizedProviderApp, getProviderApp } from "@/lib/provider-apps";
import {
  buildOpenMeterUsageResponse,
  queryOpenMeterAppDashboardUsage,
  queryOpenMeterUsage,
  queryOpenMeterUserDailyByPipeline,
  queryOpenMeterUserPipelineByModel,
} from "@/lib/usage/query-openmeter";

export type AppUsageApp = {
  id: string;
};

/** Shared OpenMeter usage aggregation for Builder / legacy / end-user mounts. */
export async function handleAppUsageGet(input: {
  request: Request;
  app: AppUsageApp;
  /** When set, forces filter to this external user (end-user API). */
  forcedExternalUserId?: string | null;
}): Promise<NextResponse> {
  if (!requireOpenMeterForUsageReads()) {
    return NextResponse.json(
      { error: "OpenMeter not configured (OPENMETER_URL required)" },
      { status: 503 },
    );
  }

  const url = new URL(input.request.url);
  const startDate = url.searchParams.get("startDate");
  const endDate = url.searchParams.get("endDate");
  const groupBy = url.searchParams.get("groupBy") || "none";

  let filterUserId: string | null = null;
  if (input.forcedExternalUserId?.trim()) {
    filterUserId = input.forcedExternalUserId.trim();
  } else if (url.searchParams.get("userId")?.trim()) {
    const parsed = requireExternalUserId(url.searchParams.get("userId"));
    if (!parsed.ok) return parsed.response;
    filterUserId = parsed.externalUserId;
  }

  if (groupBy === "daily_pipeline" && !filterUserId) {
    return NextResponse.json(
      { error: "userId is required when groupBy=daily_pipeline" },
      { status: 400 },
    );
  }

  if (startDate && Number.isNaN(Date.parse(startDate))) {
    return NextResponse.json({ error: "Invalid startDate format" }, { status: 400 });
  }
  if (endDate && Number.isNaN(Date.parse(endDate))) {
    return NextResponse.json({ error: "Invalid endDate format" }, { status: 400 });
  }

  const includeRetail =
    url.searchParams.get("include") === "retail" ||
    url.searchParams.get("includeRetail") === "1" ||
    url.searchParams.get("includeRetail") === "true";

  const omRows = await queryOpenMeterUsage({
    clientId: input.app.id,
    startDate,
    endDate,
    externalUserId: filterUserId,
  });

  let pipelineRows;
  let dailyPipelineRows;
  if (groupBy === "pipeline_model") {
    if (filterUserId?.trim()) {
      pipelineRows = await queryOpenMeterUserPipelineByModel({
        clientId: input.app.id,
        startDate,
        endDate,
        externalUserId: filterUserId.trim(),
      });
    } else {
      const dashboard = await queryOpenMeterAppDashboardUsage({
        clientId: input.app.id,
        startDate,
        endDate,
      });
      pipelineRows = dashboard?.byPipelineModel ?? [];
    }
  }
  if (groupBy === "daily_pipeline" && filterUserId) {
    dailyPipelineRows = await queryOpenMeterUserDailyByPipeline({
      clientId: input.app.id,
      startDate,
      endDate,
      externalUserId: filterUserId,
    });
  }

  let retailByPipelineModel:
    | Map<string, { endUserBillableUsdMicros: string; retailRateUsd: string }>
    | undefined;
  if (includeRetail) {
    const lookup = await loadActiveRetailRatesForApp(input.app.id);
    retailByPipelineModel = new Map();
    const rowsForRetail = pipelineRows ?? [];
    if (rowsForRetail.length === 0 && omRows.length > 0) {
      const rate = resolveRetailRateForUsage({ lookup });
      const network = omRows.reduce(
        (sum, row) => sum + BigInt(row.networkFeeUsdMicros),
        0n,
      );
      retailByPipelineModel.set("*|*", {
        retailRateUsd: rate,
        endUserBillableUsdMicros: estimateEndUserBillableMicros({
          networkFeeUsdMicros: network,
          lookup,
        }),
      });
    } else {
      for (const row of rowsForRetail) {
        const key = `${row.pipeline}|${row.modelId}`;
        const rate = resolveRetailRateForUsage({
          lookup,
          pipeline: row.pipeline,
          modelId: row.modelId,
        });
        retailByPipelineModel.set(key, {
          retailRateUsd: rate,
          endUserBillableUsdMicros: estimateEndUserBillableMicros({
            networkFeeUsdMicros: BigInt(row.networkFeeUsdMicros),
            lookup,
            pipeline: row.pipeline,
            modelId: row.modelId,
          }),
        });
      }
    }
  }

  const response = buildOpenMeterUsageResponse({
    clientId: input.app.id,
    startDate,
    endDate,
    groupBy,
    filterUserId,
    rows: omRows,
    pipelineRows,
    dailyPipelineRows,
    includeRetail,
    retailByPipelineModel,
  });
  return NextResponse.json(response);
}

export async function handleAppUsageBalanceGet(input: {
  app: AppUsageApp;
  externalUserId: string;
}): Promise<NextResponse> {
  const externalUserId = input.externalUserId.trim();
  if (!externalUserId) {
    return NextResponse.json({ error: "externalUserId is required" }, { status: 400 });
  }

  const balance = await getTrialCreditBalance({
    clientId: input.app.id,
    externalUserId,
  });
  if (!balance) {
    return NextResponse.json({ error: "OpenMeter not configured" }, { status: 503 });
  }

  return NextResponse.json({
    externalUserId,
    ...balance,
    remainingUsdMicros: balance.balanceUsdMicros,
  });
}

/** Authorize Builder/legacy app usage. Prefer m2mOnly for Builder contract paths. */
export async function resolveAppForUsageAccess(input: {
  request: Request;
  clientId: string;
  /** When true, reject provider-session auth (Builder / Phase-2 usage). */
  m2mOnly?: boolean;
}): Promise<AppUsageApp | null> {
  const clientAuth = await authenticateAppClient(input.request);
  if (clientAuth?.appId === input.clientId) {
    return getProviderApp(input.clientId);
  }
  if (input.m2mOnly) {
    return null;
  }

  try {
    const providerAuth = await getAuthorizedProviderApp(input.clientId);
    return providerAuth?.app ?? null;
  } catch {
    return null;
  }
}
