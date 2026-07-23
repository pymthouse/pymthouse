import { NextResponse } from "next/server";

import { authenticateAppClient } from "@/lib/auth";
import { requireOpenMeterForUsageReads } from "@/lib/openmeter/constants";
import { getUsageBalanceAllowance } from "@/lib/openmeter/spendable-allowance";
import { getAuthorizedProviderApp, getProviderApp } from "@/lib/provider-apps";
import {
  buildAppUsageResponse,
  parseUsageQueryParams,
  validateUsageDateParams,
} from "@/lib/usage/build-app-usage-response";

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
  const { startDate, endDate, groupBy, includeRetail } = parseUsageQueryParams(
    url.searchParams,
  );
  const filterUserId =
    input.forcedExternalUserId?.trim() ||
    url.searchParams.get("userId") ||
    null;

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
    appId: input.app.id,
    startDate,
    endDate,
    groupBy,
    filterUserId,
    includeRetail,
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

  const balance = await getUsageBalanceAllowance({
    clientId: input.app.id,
    externalUserId,
  });
  if (!balance) {
    return NextResponse.json({ error: "OpenMeter not configured" }, { status: 503 });
  }

  return NextResponse.json({
    externalUserId,
    ...balance,
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
