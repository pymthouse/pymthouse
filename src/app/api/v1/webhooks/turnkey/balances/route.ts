import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/db/index";
import { signerDepositEvents } from "@/db/schema";
import {
  clearAttributedDeposit,
  retryDepositCredit,
} from "@/lib/signer/deposit-clearing";
import {
  classifyIngressAsset,
  isArbitrumMainnetCaip2,
  isBalanceFinalizedEvent,
  isDepositOperation,
  parseBalanceFinalizedMessage,
} from "@/lib/turnkey/deposit-assets";
import {
  getSharedSignerEthAddress,
  getTransactionFromAddress,
  resolveDepositPayerByWalletAddress,
} from "@/lib/turnkey/resolve-deposit-payer";
import { normalizeWalletAddress } from "@/lib/turnkey";
import { verifyTurnkeyWebhookRequest } from "@/lib/turnkey/verify-webhook";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  let verified;
  try {
    verified = await verifyTurnkeyWebhookRequest(request.headers, rawBody);
  } catch (err) {
    console.error("Turnkey webhook verification error:", err);
    return NextResponse.json({ error: "Webhook verification failed" }, { status: 500 });
  }

  if (!verified) {
    return NextResponse.json({ error: "Invalid webhook signature" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody) as unknown;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!isBalanceFinalizedEvent(payload)) {
    return NextResponse.json({ ok: true, skipped: "unsupported_event_type" });
  }

  const message = parseBalanceFinalizedMessage(payload);
  if (!message) {
    return NextResponse.json({ error: "Unparseable balance message" }, { status: 400 });
  }

  if (!isArbitrumMainnetCaip2(message.caip2)) {
    return NextResponse.json({ ok: true, skipped: "unsupported_chain" });
  }

  if (!isDepositOperation(message.operation)) {
    return NextResponse.json({ ok: true, skipped: "unsupported_operation" });
  }

  const ingressAsset = classifyIngressAsset(message.assetCaip19);
  if (!ingressAsset) {
    return NextResponse.json({ ok: true, skipped: "unsupported_asset" });
  }

  const signerAddress = await getSharedSignerEthAddress();
  const monitored = normalizeWalletAddress(message.walletAddress);
  if (!signerAddress || !monitored || monitored !== signerAddress) {
    return NextResponse.json({ ok: true, skipped: "not_shared_signer_address" });
  }

  const idempotencyKey = verified.eventId || message.idempotencyKey;

  const existing = await db
    .select()
    .from(signerDepositEvents)
    .where(eq(signerDepositEvents.idempotencyKey, idempotencyKey))
    .limit(1);

  if (existing[0]) {
    const row = existing[0];
    if (row.status === "credited") {
      return NextResponse.json({
        ok: true,
        duplicate: true,
        status: row.status,
        fundTxHash: row.fundTxHash,
        usdMicrosCredited: row.usdMicrosCredited,
      });
    }
    if (row.status === "funded") {
      try {
        const retried = await retryDepositCredit(row.id);
        return NextResponse.json({
          ok: true,
          retried: true,
          status: retried.status,
          fundTxHash: retried.fundTxHash,
          usdMicrosCredited: retried.usdMicrosCredited,
        });
      } catch (err) {
        console.error("retryDepositCredit failed:", err);
        return NextResponse.json({ error: "Failed to credit allowance" }, { status: 500 });
      }
    }
    if (row.status === "pending") {
      return NextResponse.json({
        ok: true,
        duplicate: true,
        status: row.status,
        note: "funding_in_progress",
      });
    }
    return NextResponse.json({
      ok: true,
      duplicate: true,
      status: row.status,
    });
  }

  let fromAddress: string | null = null;
  if (message.transactionHash) {
    try {
      fromAddress = await getTransactionFromAddress(message.transactionHash);
    } catch (err) {
      console.error("Failed to resolve deposit tx.from:", err);
      return NextResponse.json({ error: "Failed to resolve payer" }, { status: 500 });
    }
  }

  const eventId = uuidv4();
  const baseEvent = {
    id: eventId,
    idempotencyKey,
    txHash: message.transactionHash,
    fromAddress,
    amountWei: message.amountWei,
    ingressAsset,
    status: "unmatched" as const,
  };

  if (!fromAddress) {
    await db.insert(signerDepositEvents).values({
      ...baseEvent,
      errorMessage: "missing_transaction_hash_or_from",
    });
    return NextResponse.json({ ok: true, status: "unmatched" });
  }

  const payer = await resolveDepositPayerByWalletAddress(fromAddress);
  if (!payer) {
    await db.insert(signerDepositEvents).values(baseEvent);
    return NextResponse.json({ ok: true, status: "unmatched" });
  }

  let amountRaw: bigint;
  try {
    amountRaw = BigInt(message.amountWei);
  } catch {
    await db.insert(signerDepositEvents).values({
      ...baseEvent,
      status: "error",
      errorMessage: "invalid_amount",
    });
    return NextResponse.json({ ok: true, status: "error", error: "invalid_amount" });
  }

  if (amountRaw <= 0n) {
    await db.insert(signerDepositEvents).values({
      ...baseEvent,
      status: "error",
      errorMessage: "non_positive_amount",
    });
    return NextResponse.json({ ok: true, status: "error", error: "non_positive_amount" });
  }

  try {
    const cleared = await clearAttributedDeposit({
      eventId,
      idempotencyKey,
      txHash: message.transactionHash,
      fromAddress,
      payer,
      ingressAsset,
      amountRaw: message.amountWei,
    });

    return NextResponse.json({
      ok: true,
      status: cleared.status,
      appId: payer.appId,
      externalUserId: payer.externalUserId,
      fundTxHash: cleared.fundTxHash,
      usdMicrosCredited: cleared.usdMicrosCredited,
      ingressAsset,
      ethWeiRealized: cleared.ethWeiRealized,
      swapTxHash: cleared.swapTxHash ?? null,
    });
  } catch (err) {
    console.error("clearAttributedDeposit failed:", err);
    return NextResponse.json({ error: "Failed to fund deposit or credit allowance" }, { status: 500 });
  }
}
