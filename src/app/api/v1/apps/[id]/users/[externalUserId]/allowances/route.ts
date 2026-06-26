import { NextRequest, NextResponse } from "next/server";
import { authorizeAppForBilling } from "@/lib/billing/app-auth";
import type { GrantSource } from "@/lib/billing/types";
import { getTrialCreditBalance } from "@/lib/openmeter/entitlements";
import { grantAllowanceUsdMicros } from "@/lib/openmeter/grant-allowance";

const GRANT_SOURCES = new Set<GrantSource>([
  "trial",
  "manual",
  "promo",
  "plan_adjustment",
]);

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; externalUserId: string }> },
) {
  const { id: clientId, externalUserId: raw } = await params;
  const externalUserId = decodeURIComponent(raw);
  const access = await authorizeAppForBilling(request, clientId);
  if (!access) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const balance = await getTrialCreditBalance({
    clientId: access.app.id,
    externalUserId,
  });
  if (!balance) {
    return NextResponse.json({ error: "OpenMeter not configured" }, { status: 503 });
  }

  return NextResponse.json({
    externalUserId,
    allowances: {
      balanceUsdMicros: balance.balanceUsdMicros,
      consumedUsdMicros: balance.consumedUsdMicros,
      lifetimeGrantedUsdMicros: balance.lifetimeGrantedUsdMicros,
      hasAccess: balance.hasAccess,
    },
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; externalUserId: string }> },
) {
  const { id: clientId, externalUserId: raw } = await params;
  const externalUserId = decodeURIComponent(raw);
  const access = await authorizeAppForBilling(request, clientId);
  if (!access) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));
  const amountUsdMicros = BigInt(String(body.amountUsdMicros || "0"));
  if (amountUsdMicros <= 0n) {
    return NextResponse.json({ error: "amountUsdMicros must be positive" }, { status: 400 });
  }

  const sourceRaw = String(body.source || "manual").trim() as GrantSource;
  const source = GRANT_SOURCES.has(sourceRaw) ? sourceRaw : "manual";

  const featureKey =
    typeof body.featureKey === "string" && body.featureKey.trim()
      ? body.featureKey.trim()
      : undefined;

  try {
    const result = await grantAllowanceUsdMicros({
      clientId: access.app.id,
      externalUserId,
      amountUsdMicros,
      source,
      featureKey,
    });

    const response: Record<string, unknown> = {
      externalUserId: result.externalUserId,
      source: result.source,
      grantedUsdMicros: result.grantedUsdMicros,
      featureKey: result.featureKey,
    };
    if (result.balance) {
      Object.assign(response, result.balance);
    }
    return NextResponse.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Grant failed";
    if (message.includes("OpenMeter not configured")) {
      return NextResponse.json({ error: message }, { status: 503 });
    }
    console.error("[allowances] grant failed:", err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
