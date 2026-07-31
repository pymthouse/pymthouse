import { NextResponse } from "next/server";

import { calendarMonthBoundsUtc } from "@/lib/billing-utils";
import { requireOpenMeterForUsageReads } from "@/lib/openmeter/constants";
import { listEndUserSignedTicketRequests } from "@/lib/openmeter/signed-ticket-events";
import { getAuthorizedProviderApp } from "@/lib/provider-apps";
import { resolveAppPublicClientId } from "@/lib/usage/identity-rollup";

const MAX_LIMIT = 100;

function parseLimit(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 25;
  return Math.min(parsed, MAX_LIMIT);
}

/**
 * Signed-ticket request log for one identity on one app.
 *
 * Authorization is app ownership, deliberately not viewer-subject scope: an app
 * owner may read any identity under their own app, which is why this lives here
 * rather than on `/api/v1/me/usage/requests` (that route rejects
 * `externalUserId` outright so viewers cannot read other identities).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; externalUserId: string }> },
) {
  const { id: appId, externalUserId: rawExternalUserId } = await params;
  const externalUserId = decodeURIComponent(rawExternalUserId).trim();
  if (!externalUserId) {
    return NextResponse.json({ error: "externalUserId is required" }, { status: 400 });
  }

  let providerAuth: Awaited<ReturnType<typeof getAuthorizedProviderApp>> | null = null;
  try {
    providerAuth = await getAuthorizedProviderApp(appId);
  } catch {
    providerAuth = null;
  }
  if (!providerAuth) {
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
  const from = url.searchParams.get("from") || cycle.start;
  const to = url.searchParams.get("to") || cycle.end;

  if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
    return NextResponse.json({ error: "Invalid date range" }, { status: 400 });
  }

  const publicClientId = await resolveAppPublicClientId(providerAuth.app.id);
  const result = await listEndUserSignedTicketRequests({
    externalUserId,
    clientId: publicClientId,
    manifestId: url.searchParams.get("manifestId"),
    cursor: url.searchParams.get("cursor"),
    limit: parseLimit(url.searchParams.get("limit")),
    from,
    to,
  });

  return NextResponse.json(result);
}
