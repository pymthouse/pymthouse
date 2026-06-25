import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/db/index";
import { signerDepositEvents } from "@/db/schema";
import { computeUsdMicrosFromWei } from "@/lib/billing-runtime";
import { grantAllowanceUsdMicros } from "@/lib/openmeter/grant-allowance";
import { getEthUsdOracle } from "@/lib/prices/eth-usd-oracle";
import {
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

  const signerAddress = await getSharedSignerEthAddress();
  const monitored = normalizeWalletAddress(message.walletAddress);
  if (!signerAddress || !monitored || monitored !== signerAddress) {
    return NextResponse.json({ ok: true, skipped: "not_shared_signer_address" });
  }

  const idempotencyKey = verified.eventId || message.idempotencyKey;

  const existing = await db
    .select({ id: signerDepositEvents.id, status: signerDepositEvents.status })
    .from(signerDepositEvents)
    .where(eq(signerDepositEvents.idempotencyKey, idempotencyKey))
    .limit(1);

  if (existing[0]) {
    return NextResponse.json({
      ok: true,
      duplicate: true,
      status: existing[0].status,
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

  let amountWei: bigint;
  try {
    amountWei = BigInt(message.amountWei);
  } catch {
    await db.insert(signerDepositEvents).values({
      ...baseEvent,
      status: "error",
      errorMessage: "invalid_amount_wei",
    });
    return NextResponse.json({ ok: true, status: "error", error: "invalid_amount_wei" });
  }

  if (amountWei <= 0n) {
    await db.insert(signerDepositEvents).values({
      ...baseEvent,
      status: "error",
      errorMessage: "non_positive_amount",
    });
    return NextResponse.json({ ok: true, status: "error", error: "non_positive_amount" });
  }

  const oracle = await getEthUsdOracle();
  const usdMicros = computeUsdMicrosFromWei(amountWei, oracle.priceUsd);
  if (usdMicros <= 0n) {
    await db.insert(signerDepositEvents).values({
      ...baseEvent,
      ethUsdPrice: String(oracle.priceUsd),
      status: "error",
      errorMessage: "zero_usd_micros",
    });
    return NextResponse.json({ ok: true, status: "error", error: "zero_usd_micros" });
  }

  try {
    await grantAllowanceUsdMicros({
      clientId: payer.appId,
      externalUserId: payer.externalUserId,
      amountUsdMicros: usdMicros,
      source: "onchain_deposit",
    });
  } catch (err) {
    console.error("grantAllowanceUsdMicros failed for onchain deposit:", err);
    return NextResponse.json({ error: "Failed to credit allowance" }, { status: 500 });
  }

  await db.insert(signerDepositEvents).values({
    ...baseEvent,
    ethUsdPrice: String(oracle.priceUsd),
    usdMicrosCredited: usdMicros.toString(),
    appId: payer.appId,
    externalUserId: payer.externalUserId,
    status: "credited",
  });

  return NextResponse.json({
    ok: true,
    status: "credited",
    appId: payer.appId,
    externalUserId: payer.externalUserId,
    usdMicrosCredited: usdMicros.toString(),
  });
}
