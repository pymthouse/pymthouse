import { NextResponse } from "next/server";

import {
  calendarMonthBoundsUtc,
  isValidBoundedDateRange,
} from "@/lib/billing-utils";
import { authenticateAppClient } from "@/lib/auth";
import { requireOpenMeterForUsageReads } from "@/lib/openmeter/constants";
import { getAuthorizedProviderApp, getProviderApp } from "@/lib/provider-apps";
import { listAppIdentities } from "@/lib/usage/identity-rollup";

/**
 * M2M identities for one app with cycle usage, sorted by network fee desc.
 * Cycle bounds are UTC; the UI renders them in the viewer's local timezone.
 */
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
    } catch (err) {
      console.warn(
        "apps-identities: auth resolution failed",
        clientId,
        err instanceof Error ? err.message : String(err),
      );
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
  const cycle = calendarMonthBoundsUtc(new Date());
  const startDate = url.searchParams.get("startDate") || cycle.start;
  const endDate = url.searchParams.get("endDate") || cycle.end;

  if (!isValidBoundedDateRange(startDate, endDate)) {
    return NextResponse.json({ error: "Invalid date range" }, { status: 400 });
  }

  const identities = await listAppIdentities({
    clientId: app.id,
    startDate,
    endDate,
  });

  return NextResponse.json({
    appId: app.id,
    appName: app.name,
    cycle: { start: startDate, end: endDate },
    identities,
  });
}
