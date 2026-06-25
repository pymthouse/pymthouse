import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/db/index";
import { developerApps, x402Settlements } from "@/db/schema";
import {
  parseX402PaymentHeader,
  verifyEip3009Payment,
} from "@/lib/x402/eip3009";
import { creditX402Settlement, settleX402OnBase } from "@/lib/x402/settle";
import { BASE_MAINNET_CAIP2, BASE_USDC_ADDRESS, type X402PaymentRequirements } from "@/lib/x402/types";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  let body: {
    paymentHeader?: string;
    requirements?: {
      scheme: "exact";
      network: string;
      maxAmountRequired: string;
      resource: string;
      payTo: string;
      maxTimeoutSeconds: number;
      asset: string;
    };
    appId?: string;
    externalUserId?: string;
  };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const paymentHeader =
    body.paymentHeader ||
    request.headers.get("x-payment") ||
    request.headers.get("X-PAYMENT");

  const payment = parseX402PaymentHeader(paymentHeader);
  if (!payment || !body.requirements) {
    return NextResponse.json({ error: "Missing payment or requirements" }, { status: 400 });
  }

  const requirements: X402PaymentRequirements = {
    ...body.requirements,
    scheme: "exact",
    network: BASE_MAINNET_CAIP2,
    asset: BASE_USDC_ADDRESS,
  };

  let verified;
  try {
    verified = await verifyEip3009Payment({ payment, requirements });
  } catch (err) {
    const message = err instanceof Error ? err.message : "verification_failed";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }

  const existing = await db
    .select()
    .from(x402Settlements)
    .where(eq(x402Settlements.authorizationNonce, verified.nonce))
    .limit(1);

  if (existing[0]?.status === "settled") {
    return NextResponse.json({
      ok: true,
      duplicate: true,
      txHash: existing[0].txHash,
      usdMicrosCredited: existing[0].usdMicrosCredited,
    });
  }

  const settlementId = existing[0]?.id ?? uuidv4();
  if (!existing[0]) {
    await db.insert(x402Settlements).values({
      id: settlementId,
      authorizationNonce: verified.nonce,
      payer: verified.payer,
      payTo: verified.payTo,
      asset: BASE_USDC_ADDRESS,
      amountRaw: verified.value.toString(),
      caip2: BASE_MAINNET_CAIP2,
      appId: body.appId ?? null,
      externalUserId: body.externalUserId ?? null,
      status: "verified",
    });
  }

  let builderCode: string | null = null;
  if (body.appId) {
    const appRows = await db
      .select({ x402BuilderCode: developerApps.x402BuilderCode })
      .from(developerApps)
      .where(eq(developerApps.id, body.appId))
      .limit(1);
    builderCode = appRows[0]?.x402BuilderCode ?? null;
  }

  let txHash: string;
  try {
    const settled = await settleX402OnBase({ verified, builderCode });
    txHash = settled.txHash;
  } catch (err) {
    console.error("settleX402OnBase failed:", err);
    await db
      .update(x402Settlements)
      .set({
        status: "failed",
        errorMessage: err instanceof Error ? err.message : "settle_failed",
      })
      .where(eq(x402Settlements.id, settlementId));
    return NextResponse.json({ error: "Settlement failed" }, { status: 500 });
  }

  let credit;
  try {
    credit = await creditX402Settlement({
      payer: verified.payer,
      amountRaw: verified.value,
      appId: body.appId,
      externalUserId: body.externalUserId,
    });
  } catch (err) {
    console.error("creditX402Settlement failed:", err);
    await db
      .update(x402Settlements)
      .set({
        status: "failed",
        txHash,
        builderCode,
        errorMessage: err instanceof Error ? err.message : "credit_failed",
      })
      .where(eq(x402Settlements.id, settlementId));
    return NextResponse.json({ error: "Credit failed" }, { status: 500 });
  }

  await db
    .update(x402Settlements)
    .set({
      status: "settled",
      txHash,
      builderCode,
      appId: credit.appId,
      externalUserId: credit.externalUserId,
      usdMicrosCredited: credit.usdMicrosCredited,
    })
    .where(eq(x402Settlements.id, settlementId));

  return NextResponse.json({
    ok: true,
    status: "settled",
    txHash,
    payer: verified.payer,
    appId: credit.appId,
    externalUserId: credit.externalUserId,
    usdMicrosCredited: credit.usdMicrosCredited,
  });
}
