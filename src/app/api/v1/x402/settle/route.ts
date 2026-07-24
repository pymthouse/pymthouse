import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { x402Payments } from "@/db/schema";
import { grantAllowanceUsdMicros } from "@/lib/openmeter/grant-allowance";
import {
  authenticateX402AgentOrApp,
  requireX402EnabledApp,
  settleExactEip3009Payment,
  usdcAtomicToUsdMicros,
  x402SettleRequestSchema,
} from "@/lib/x402";

/**
 * POST /api/v1/x402/settle
 * M2M Basic + x402:settle only. Settles on-chain and grants OpenMeter credits.
 */
export async function POST(request: Request) {
  const auth = await authenticateX402AgentOrApp(request, {
    requireSettleScope: true,
  });
  if (!auth.ok) {
    return auth.response;
  }
  const disabled = await requireX402EnabledApp(auth.context);
  if (disabled) {
    return disabled;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = x402SettleRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { paymentPayload, paymentRequirements, externalUserId } = parsed.data;
  if (
    auth.context.x402PayToAddress &&
    paymentRequirements.payTo.toLowerCase() !==
      auth.context.x402PayToAddress.toLowerCase()
  ) {
    return NextResponse.json(
      { success: false, error: "pay_to_not_registered_for_app" },
      { status: 400 },
    );
  }

  const authz = paymentPayload.payload.authorization;
  const existing = await db
    .select()
    .from(x402Payments)
    .where(
      and(
        eq(x402Payments.asset, paymentRequirements.asset.toLowerCase()),
        eq(x402Payments.fromAddress, authz.from.toLowerCase()),
        eq(x402Payments.nonce, authz.nonce.toLowerCase()),
      ),
    )
    .limit(1);

  if (existing[0]?.status === "settled") {
    return NextResponse.json({
      success: true,
      txHash: existing[0].txHash ?? undefined,
      networkId: existing[0].network,
      payer: authz.from,
      alreadySettled: true,
    });
  }

  const settlement = await settleExactEip3009Payment({
    paymentPayload,
    paymentRequirements,
  });

  const now = new Date().toISOString();
  const paymentId = existing[0]?.id ?? randomUUID();

  if (!settlement.success) {
    if (existing[0]) {
      await db
        .update(x402Payments)
        .set({
          status: "failed",
          errorMessage: settlement.error ?? "settlement_failed",
          updatedAt: now,
        })
        .where(eq(x402Payments.id, existing[0].id));
    } else {
      await db.insert(x402Payments).values({
        id: paymentId,
        clientId: auth.context.appId,
        scheme: paymentRequirements.scheme,
        network: paymentRequirements.network,
        asset: paymentRequirements.asset.toLowerCase(),
        fromAddress: authz.from.toLowerCase(),
        payTo: paymentRequirements.payTo.toLowerCase(),
        valueAtomic: authz.value,
        nonce: authz.nonce.toLowerCase(),
        status: "failed",
        errorMessage: settlement.error ?? "settlement_failed",
        externalUserId: externalUserId ?? null,
        createdAt: now,
        updatedAt: now,
      });
    }
    return NextResponse.json(settlement, { status: 402 });
  }

  let grantedUsdMicros: string | undefined;
  const creditExternalUserId =
    externalUserId?.trim() ||
    auth.context.externalUserId?.trim() ||
    null;

  if (creditExternalUserId) {
    try {
      const amountUsdMicros = usdcAtomicToUsdMicros(authz.value);
      const grant = await grantAllowanceUsdMicros({
        clientId: auth.context.appId,
        externalUserId: creditExternalUserId,
        amountUsdMicros,
        source: "x402",
        idempotencyKey: paymentId,
      });
      grantedUsdMicros = grant.grantedUsdMicros;
    } catch (err) {
      console.error("[x402/settle] credit grant failed:", err);
    }
  }

  if (existing[0]) {
    await db
      .update(x402Payments)
      .set({
        status: "settled",
        txHash: settlement.txHash ?? null,
        externalUserId: creditExternalUserId,
        grantedUsdMicros: grantedUsdMicros ?? null,
        errorMessage: null,
        updatedAt: now,
        settledAt: now,
      })
      .where(eq(x402Payments.id, existing[0].id));
  } else {
    await db.insert(x402Payments).values({
      id: paymentId,
      clientId: auth.context.appId,
      scheme: paymentRequirements.scheme,
      network: paymentRequirements.network,
      asset: paymentRequirements.asset.toLowerCase(),
      fromAddress: authz.from.toLowerCase(),
      payTo: paymentRequirements.payTo.toLowerCase(),
      valueAtomic: authz.value,
      nonce: authz.nonce.toLowerCase(),
      status: "settled",
      txHash: settlement.txHash ?? null,
      externalUserId: creditExternalUserId,
      grantedUsdMicros: grantedUsdMicros ?? null,
      createdAt: now,
      updatedAt: now,
      settledAt: now,
    });
  }

  return NextResponse.json({
    ...settlement,
    grantedUsdMicros,
  });
}
