import { NextRequest, NextResponse } from "next/server";
import { getTrialCreditBalance } from "@/lib/openmeter/entitlements";
import { buildOpenMeterCustomerKey } from "@/lib/openmeter/customer-key";

/**
 * OpenMeter / Konnect entitlement notification webhook.
 *
 * When balance is exhausted (or a threshold rule fires), Konnect can POST here.
 * We re-check live balance and return an enforcement decision so integrators
 * (or the signer balance gate) can cut off signing when credits are depleted.
 *
 * Configure the notification rule in Konnect to target this path with a shared
 * secret header `x-openmeter-webhook-secret` matching OPENMETER_WEBHOOK_SECRET.
 */
export async function POST(request: NextRequest) {
  const expected = process.env.OPENMETER_WEBHOOK_SECRET?.trim();
  if (expected) {
    const provided = request.headers.get("x-openmeter-webhook-secret")?.trim();
    if (!provided || provided !== expected) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const customerKey =
    (typeof body.customerKey === "string" && body.customerKey.trim()) ||
    (typeof body.subject === "string" && body.subject.trim()) ||
    (typeof (body.data as { customerKey?: string } | undefined)?.customerKey === "string"
      ? (body.data as { customerKey: string }).customerKey.trim()
      : "");

  if (!customerKey || !customerKey.includes(":")) {
    return NextResponse.json(
      { error: "customerKey (clientId:externalUserId) is required" },
      { status: 400 },
    );
  }

  const [clientId, ...rest] = customerKey.split(":");
  const externalUserId = rest.join(":");
  if (!clientId || !externalUserId) {
    return NextResponse.json({ error: "Invalid customerKey" }, { status: 400 });
  }

  // Validate key shape matches our canonical builder.
  if (buildOpenMeterCustomerKey(clientId, externalUserId) !== customerKey) {
    return NextResponse.json({ error: "Invalid customerKey encoding" }, { status: 400 });
  }

  const balance = await getTrialCreditBalance({
    clientId,
    externalUserId,
  });

  const balanceUsdMicros = balance?.balanceUsdMicros ?? "0";
  const hasAccess = balance?.hasAccess ?? false;
  const exhausted = !hasAccess || BigInt(balanceUsdMicros) <= 0n;

  return NextResponse.json({
    ok: true,
    customerKey,
    clientId,
    externalUserId,
    balanceUsdMicros,
    hasAccess,
    enforce: exhausted ? "deny_signing" : "allow",
    action: exhausted ? "cut_off" : "none",
  });
}
