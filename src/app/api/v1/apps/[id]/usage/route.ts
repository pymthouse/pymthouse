import { NextResponse } from "next/server";
import { authenticateAppClient } from "@/lib/auth";
import { requireOpenMeterForUsageReads } from "@/lib/openmeter/constants";
import { getAuthorizedProviderApp, getProviderApp } from "@/lib/provider-apps";
import {
  buildAppUsageResponse,
  parseUsageQueryParams,
  validateUsageDateParams,
} from "@/lib/usage/build-app-usage-response";

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
  const { startDate, endDate, groupBy, includeRetail } = parseUsageQueryParams(
    url.searchParams,
  );
  const filterUserId = url.searchParams.get("userId");

  if (groupBy === "daily_pipeline" && !filterUserId?.trim()) {
    return NextResponse.json(
      { error: "userId is required when groupBy=daily_pipeline" },
      { status: 400 },
    );
  }

  const dateError = validateUsageDateParams(startDate, endDate);
  if (dateError) {
    return NextResponse.json({ error: dateError }, { status: 400 });
  }

  const response = await buildAppUsageResponse({
    appId: app.id,
    startDate,
    endDate,
    groupBy,
    filterUserId,
    includeRetail,
  });
  return NextResponse.json(response);
}
