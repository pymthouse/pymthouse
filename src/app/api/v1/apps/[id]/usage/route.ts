import { NextResponse } from "next/server";
import { authenticateAppClient } from "@/lib/auth";
import {
  estimateEndUserBillableMicros,
  loadActiveRetailRatesForApp,
  loadRetailRatesForAppUser,
  resolveRetailRateForUsage,
} from "@/lib/billing/retail-usage";
import { requireOpenMeterForUsageReads } from "@/lib/openmeter/constants";
import { getAuthorizedProviderApp, getProviderApp } from "@/lib/provider-apps";
import {
  buildOpenMeterUsageResponse,
  queryOpenMeterAppDashboardUsage,
  queryOpenMeterUsage,
  queryOpenMeterUserDailyByPipeline,
  queryOpenMeterUserPipelineByModel,
} from "@/lib/usage/query-openmeter";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const clientAuth = await authenticateAppClient(request);

  let app: Awaited<ReturnType<typeof getProviderApp>> | null = null;
  if (clientAuth?.appId === clientId) {
    app = await getProviderApp(clientId);
  } else {
    let providerAuth: Awaited<ReturnType<typeof getAuthorizedProviderApp>> | null = null;
    try {
      providerAuth = await getAuthorizedProviderApp(clientId);
    } catch {
      providerAuth = null;
    }
    if (!providerAuth) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    app = providerAuth.app;
  }

  if (!app) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!requireOpenMeterForUsageReads()) {
    return NextResponse.json(
      { error: "OpenMeter not configured (OPENMETER_URL required)" },
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  const startDate = url.searchParams.get("startDate");
  const endDate = url.searchParams.get("endDate");
  const groupBy = url.searchParams.get("groupBy") || "none";
  const filterUserId = url.searchParams.get("userId");

  if (groupBy === "daily_pipeline" && !filterUserId?.trim()) {
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
    clientId: app.id,
    startDate,
    endDate,
    externalUserId: filterUserId,
  });

  let pipelineRows;
  let dailyPipelineRows;
  if (groupBy === "pipeline_model") {
    if (filterUserId?.trim()) {
      pipelineRows = await queryOpenMeterUserPipelineByModel({
        clientId: app.id,
        startDate,
        endDate,
        externalUserId: filterUserId.trim(),
      });
    } else {
      const dashboard = await queryOpenMeterAppDashboardUsage({
        clientId: app.id,
        startDate,
        endDate,
      });
      pipelineRows = dashboard?.byPipelineModel ?? [];
    }
  }
  if (groupBy === "daily_pipeline" && filterUserId) {
    dailyPipelineRows = await queryOpenMeterUserDailyByPipeline({
      clientId: app.id,
      startDate,
      endDate,
      externalUserId: filterUserId,
    });
  }

  let retailByPipelineModel: Map<
    string,
    { endUserBillableUsdMicros: string; retailRateUsd: string }
  > | undefined;
  if (includeRetail) {
    const lookup = filterUserId?.trim()
      ? await loadRetailRatesForAppUser({
          clientId: app.id,
          externalUserId: filterUserId.trim(),
        })
      : await loadActiveRetailRatesForApp(app.id);
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
    clientId: app.id,
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
