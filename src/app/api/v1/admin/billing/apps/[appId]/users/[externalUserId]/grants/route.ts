import { NextResponse } from "next/server";

import { withAdminGuardParams } from "@/lib/api-guards";
import { createCorrelationId, writeAuditLog } from "@/lib/audit";
import { parseAdminGrantBody } from "@/lib/billing/admin-grant-body";
import { buildGrantIdempotencyKey } from "@/lib/billing/admin-grant-idempotency";
import {
  decideAppUserCreditGrant,
  loadAppCreditContext,
} from "@/lib/billing/admin-app-rollup";
import { grantAllowanceUsdMicros } from "@/lib/openmeter/grant-allowance";

/**
 * POST /api/v1/admin/billing/apps/[appId]/users/[externalUserId]/grants
 *
 * Merchant (and platform-default self-wallet) M2M grants. Owner-rollup apps
 * reject with 409 owner_rollup_credit_owner — credit the owner instead.
 */
export const POST = withAdminGuardParams<{
  appId: string;
  externalUserId: string;
}>(async (request, routeContext, context) => {
  const { appId, externalUserId: rawExternalUserId } = await routeContext.params;
  const externalUserId = decodeURIComponent(rawExternalUserId).trim();
  const app = await loadAppCreditContext(appId);
  if (!app) {
    return NextResponse.json({ error: "App not found" }, { status: 404 });
  }
  if (!externalUserId) {
    return NextResponse.json(
      { error: "externalUserId is required" },
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = parseAdminGrantBody(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const decision = decideAppUserCreditGrant({
    sharesOwnerCostRail: app.sharesOwnerCostRail,
    isPlatformDefault: app.isPlatformDefault,
    ownerUserId: app.ownerUserId,
    externalUserId,
  });
  if (!decision.ok) {
    return NextResponse.json(
      {
        type: "https://pymthouse.com/problems/owner-rollup-credit-owner",
        title: "Credit the owner wallet",
        status: 409,
        code: decision.code,
        ownerUserId: decision.ownerUserId,
        error: decision.error,
      },
      {
        status: 409,
        headers: { "Content-Type": "application/problem+json" },
      },
    );
  }

  const grantExternalUserId =
    decision.mode === "self_owner_wallet"
      ? decision.ownerUserId
      : externalUserId;
  const correlationId = createCorrelationId();
  const idempotencyKey = buildGrantIdempotencyKey({
    adminId: context.admin.id,
    ownerUserId: grantExternalUserId,
    amountUsdMicros: parsed.value.amountUsdMicros.toString(),
    source: parsed.value.source,
    note: parsed.value.note,
  });

  try {
    const result = await grantAllowanceUsdMicros({
      clientId: app.publicClientId,
      externalUserId: grantExternalUserId,
      amountUsdMicros: parsed.value.amountUsdMicros,
      source: parsed.value.source,
      idempotencyKey,
    });

    await writeAuditLog({
      clientId: app.publicClientId,
      actorUserId: context.admin.id,
      action: "admin_credit_grant",
      status: "success",
      correlationId,
      metadata: {
        appId: app.id,
        targetExternalUserId: grantExternalUserId,
        requestedExternalUserId: externalUserId,
        grantMode: decision.mode,
        amountUsdMicros: parsed.value.amountUsdMicros.toString(),
        source: parsed.value.source,
        note: parsed.value.note,
        featureKey: result.featureKey,
        idempotencyKey,
      },
    });

    return NextResponse.json({
      appId: app.id,
      clientId: app.publicClientId,
      externalUserId: grantExternalUserId,
      grantMode: decision.mode,
      source: result.source,
      grantedUsdMicros: result.grantedUsdMicros,
      featureKey: result.featureKey,
      note: parsed.value.note,
      balance: result.balance,
      idempotencyKey,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Grant failed";
    await writeAuditLog({
      clientId: app.publicClientId,
      actorUserId: context.admin.id,
      action: "admin_credit_grant",
      status: "error",
      correlationId,
      metadata: {
        appId: app.id,
        targetExternalUserId: grantExternalUserId,
        amountUsdMicros: parsed.value.amountUsdMicros.toString(),
        source: parsed.value.source,
        note: parsed.value.note,
        error: message,
      },
    });
    if (message.includes("OpenMeter not configured")) {
      return NextResponse.json({ error: message }, { status: 503 });
    }
    console.error("[admin/app-user-grants] grant failed:", err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
});
