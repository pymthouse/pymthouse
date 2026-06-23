import {
  estimateEndUserBillableMicros,
  loadActiveRetailRatesForApp,
  resolveRetailRateForUsage,
} from "@/lib/billing/retail-usage";
import { requireOpenMeterForUsageReads } from "@/lib/openmeter/constants";
import { getTrialCreditBalance } from "@/lib/openmeter/entitlements";
import {
  buildOpenMeterUsageResponse,
  queryOpenMeterUsage,
  queryOpenMeterUserDailyByPipeline,
  queryOpenMeterUserPipelineByModel,
} from "@/lib/usage/query-openmeter";
import { PmtHouseError, buildMeScopeUsagePayload } from "@pymthouse/builder-sdk";
import type { EndUserUsageSummary, UsageApiResponse } from "@pymthouse/builder-sdk";
import type { EndUserUsageConfig } from "@pymthouse/builder-sdk/usage";
import {
  buildEndUserIdentityConfig,
  resolveExternalUserIdForUsage,
} from "@/lib/signer/end-user-identity-config";

function assertOpenMeterConfigured(): void {
  if (!requireOpenMeterForUsageReads()) {
    throw new PmtHouseError("OpenMeter not configured (OPENMETER_URL required)", {
      status: 503,
      code: "server_error",
    });
  }
}

function validateOptionalDate(value: string | undefined, name: string): void {
  if (value && Number.isNaN(Date.parse(value))) {
    throw new PmtHouseError(`Invalid ${name} format`, {
      status: 400,
      code: "invalid_request",
    });
  }
}

export async function readBalance(input: {
  clientId: string;
  externalUserId: string;
}) {
  const balance = await getTrialCreditBalance({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });
  if (!balance) {
    throw new PmtHouseError("OpenMeter not configured", {
      status: 503,
      code: "server_error",
    });
  }

  return {
    externalUserId: input.externalUserId,
    ...balance,
    remainingUsdMicros: balance.balanceUsdMicros,
  };
}

export async function readUsage(input: {
  clientId: string;
  externalUserId: string;
  startDate?: string;
  endDate?: string;
  includeRetail?: boolean;
}): Promise<EndUserUsageSummary> {
  assertOpenMeterConfigured();
  validateOptionalDate(input.startDate, "startDate");
  validateOptionalDate(input.endDate, "endDate");

  const omRows = await queryOpenMeterUsage({
    clientId: input.clientId,
    startDate: input.startDate,
    endDate: input.endDate,
    externalUserId: input.externalUserId,
  });

  const pipelineRows = await queryOpenMeterUserPipelineByModel({
    clientId: input.clientId,
    startDate: input.startDate,
    endDate: input.endDate,
    externalUserId: input.externalUserId,
  });

  const dailyPipelineRows = await queryOpenMeterUserDailyByPipeline({
    clientId: input.clientId,
    startDate: input.startDate,
    endDate: input.endDate,
    externalUserId: input.externalUserId,
  });

  let retailByPipelineModel:
    | Map<string, { endUserBillableUsdMicros: string; retailRateUsd: string }>
    | undefined;

  if (input.includeRetail) {
    const lookup = await loadActiveRetailRatesForApp(input.clientId);
    retailByPipelineModel = new Map();
    for (const row of pipelineRows) {
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

  const usageByUser = buildOpenMeterUsageResponse({
    clientId: input.clientId,
    startDate: input.startDate,
    endDate: input.endDate,
    groupBy: "user",
    filterUserId: input.externalUserId,
    rows: omRows,
    includeRetail: input.includeRetail,
    retailByPipelineModel,
  }) as unknown as UsageApiResponse;

  const usagePipeline = buildOpenMeterUsageResponse({
    clientId: input.clientId,
    startDate: input.startDate,
    endDate: input.endDate,
    groupBy: "pipeline_model",
    filterUserId: input.externalUserId,
    rows: omRows,
    pipelineRows,
    includeRetail: input.includeRetail,
    retailByPipelineModel,
  }) as unknown as UsageApiResponse;

  const usageDaily = buildOpenMeterUsageResponse({
    clientId: input.clientId,
    startDate: input.startDate,
    endDate: input.endDate,
    groupBy: "daily_pipeline",
    filterUserId: input.externalUserId,
    rows: omRows,
    dailyPipelineRows,
  }) as unknown as UsageApiResponse;

  return buildMeScopeUsagePayload(
    usageByUser,
    input.externalUserId,
    usagePipeline,
    usageDaily,
  );
}

export function buildEndUserUsageRequestConfig(): EndUserUsageConfig {
  const identity = buildEndUserIdentityConfig();
  return {
    endUserAuth: identity.endUserAuth,
    resolveExternalUserId: resolveExternalUserIdForUsage,
    readBalance,
    readUsage,
  };
}
