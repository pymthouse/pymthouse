import { NextRequest, NextResponse } from "next/server";

import { authenticateEndUser } from "@/lib/auth/end-user";
import {
  estimateEndUserBillableMicros,
  loadActiveRetailRatesForApp,
  resolveRetailRateForUsage,
} from "@/lib/billing/retail-usage";
import { requireOpenMeterForUsageReads } from "@/lib/openmeter/constants";
import {
  buildOpenMeterUsageResponse,
  queryOpenMeterUsage,
  queryOpenMeterUserDailyByPipeline,
  queryOpenMeterUserPipelineByModel,
} from "@/lib/usage/query-openmeter";

/**
 * End-user usage for the Bearer subject only.
 * Auth: programmatic user JWT or signer JWT (subject forced — not queryable).
 */
export async function GET(request: NextRequest) {
  const auth = await authenticateEndUser(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  if (
    params.has("externalUserId") ||
    params.has("external_user_id") ||
    params.has("userId")
  ) {
    return NextResponse.json(
      {
        error:
          "userId/externalUserId are not allowed; usage is scoped to the authenticated user",
      },
      { status: 400 },
    );
  }

  if (!requireOpenMeterForUsageReads()) {
    return NextResponse.json(
      { error: "OpenMeter not configured (OPENMETER_URL required)" },
      { status: 503 },
    );
  }

  const startDate = params.get("startDate");
  const endDate = params.get("endDate");
  const groupBy = params.get("groupBy") || "none";

  if (startDate && Number.isNaN(Date.parse(startDate))) {
    return NextResponse.json({ error: "Invalid startDate format" }, { status: 400 });
  }
  if (endDate && Number.isNaN(Date.parse(endDate))) {
    return NextResponse.json({ error: "Invalid endDate format" }, { status: 400 });
  }

  const includeRetail =
    params.get("include") === "retail" ||
    params.get("includeRetail") === "1" ||
    params.get("includeRetail") === "true";

  const filterUserId = auth.externalUserId;
  const appId = auth.developerAppId;

  const omRows = await queryOpenMeterUsage({
    clientId: appId,
    startDate,
    endDate,
    externalUserId: filterUserId,
  });

  let pipelineRows;
  let dailyPipelineRows;
  if (groupBy === "pipeline_model") {
    pipelineRows = await queryOpenMeterUserPipelineByModel({
      clientId: appId,
      startDate,
      endDate,
      externalUserId: filterUserId,
    });
  }
  if (groupBy === "daily_pipeline") {
    dailyPipelineRows = await queryOpenMeterUserDailyByPipeline({
      clientId: appId,
      startDate,
      endDate,
      externalUserId: filterUserId,
    });
  }

  let retailByPipelineModel:
    | Map<string, { endUserBillableUsdMicros: string; retailRateUsd: string }>
    | undefined;
  if (includeRetail) {
    const lookup = await loadActiveRetailRatesForApp(appId);
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
  return NextResponse.json(response);
}
