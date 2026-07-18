import {
  estimateEndUserBillableMicros,
  loadActiveRetailRatesForApp,
  resolveRetailRateForUsage,
} from "@/lib/billing/retail-usage";
import {
  buildOpenMeterUsageResponse,
  queryOpenMeterAppDashboardUsage,
  queryOpenMeterUsage,
  queryOpenMeterUserDailyByPipeline,
  queryOpenMeterUserPipelineByModel,
  type OpenMeterPipelineModelRow,
  type OpenMeterDailyPipelineRow,
  type OpenMeterUsageRow,
} from "@/lib/usage/query-openmeter";

export type UsageQueryParams = {
  startDate: string | null;
  endDate: string | null;
  groupBy: string;
  includeRetail: boolean;
};

export function parseUsageQueryParams(searchParams: URLSearchParams): UsageQueryParams {
  return {
    startDate: searchParams.get("startDate"),
    endDate: searchParams.get("endDate"),
    groupBy: searchParams.get("groupBy") || "none",
    includeRetail:
      searchParams.get("include") === "retail" ||
      searchParams.get("includeRetail") === "1" ||
      searchParams.get("includeRetail") === "true",
  };
}

export function validateUsageDateParams(
  startDate: string | null,
  endDate: string | null,
): string | null {
  if (startDate && Number.isNaN(Date.parse(startDate))) {
    return "Invalid startDate format";
  }
  if (endDate && Number.isNaN(Date.parse(endDate))) {
    return "Invalid endDate format";
  }
  return null;
}

async function buildRetailByPipelineModel(input: {
  appId: string;
  pipelineRows: OpenMeterPipelineModelRow[] | undefined;
  omRows: OpenMeterUsageRow[];
}): Promise<
  Map<string, { endUserBillableUsdMicros: string; retailRateUsd: string }>
> {
  const lookup = await loadActiveRetailRatesForApp(input.appId);
  const retailByPipelineModel = new Map<
    string,
    { endUserBillableUsdMicros: string; retailRateUsd: string }
  >();
  const rowsForRetail = input.pipelineRows ?? [];
  if (rowsForRetail.length === 0 && input.omRows.length > 0) {
    const rate = resolveRetailRateForUsage({ lookup });
    const network = input.omRows.reduce(
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
    return retailByPipelineModel;
  }

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
  return retailByPipelineModel;
}

/**
 * Shared OpenMeter usage payload for apps/{id}/usage and /api/v1/user/usage.
 */
export async function buildAppUsageResponse(input: {
  appId: string;
  startDate: string | null;
  endDate: string | null;
  groupBy: string;
  filterUserId: string | null;
  includeRetail: boolean;
}): Promise<ReturnType<typeof buildOpenMeterUsageResponse>> {
  const { appId, startDate, endDate, groupBy, includeRetail } = input;
  const filterUserId = input.filterUserId?.trim() || null;

  const omRows = await queryOpenMeterUsage({
    clientId: appId,
    startDate,
    endDate,
    externalUserId: filterUserId,
  });

  let pipelineRows: OpenMeterPipelineModelRow[] | undefined;
  let dailyPipelineRows: OpenMeterDailyPipelineRow[] | undefined;
  if (groupBy === "pipeline_model") {
    if (filterUserId) {
      pipelineRows = await queryOpenMeterUserPipelineByModel({
        clientId: appId,
        startDate,
        endDate,
        externalUserId: filterUserId,
      });
    } else {
      const dashboard = await queryOpenMeterAppDashboardUsage({
        clientId: appId,
        startDate,
        endDate,
      });
      pipelineRows = dashboard?.byPipelineModel ?? [];
    }
  }
  if (groupBy === "daily_pipeline" && filterUserId) {
    dailyPipelineRows = await queryOpenMeterUserDailyByPipeline({
      clientId: appId,
      startDate,
      endDate,
      externalUserId: filterUserId,
    });
  }

  const retailByPipelineModel = includeRetail
    ? await buildRetailByPipelineModel({ appId, pipelineRows, omRows })
    : undefined;

  return buildOpenMeterUsageResponse({
    clientId: appId,
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
}
