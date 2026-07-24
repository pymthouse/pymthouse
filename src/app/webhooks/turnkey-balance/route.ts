import { verifyTurnkeyWebhookSignature } from "@turnkey/crypto";
import {
  claimTurnkeyFundingEvent,
  executeTurnkeyFunding,
  getTurnkeyFundingConfig,
  markTurnkeyFundingFailed,
  parseTurnkeyBalanceWebhookPayload,
  shouldProcessTurnkeyDeposit,
} from "@/lib/turnkey-funding";
import {
  getTurnkeyWebhookVerificationKeys,
  getTurnkeyWebhookVerificationKeysForKeyId,
} from "@/lib/turnkey-webhook-jwks";
import { sanitizeForLog } from "@/lib/sanitize-for-log";

export const maxDuration = 300;

const REPLAY_WINDOW_MS = 5 * 60 * 1000;

async function verifyTurnkeyWebhook(
  request: Request,
  rawBody: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let verificationKeys = await getTurnkeyWebhookVerificationKeys();
  let result = verifyTurnkeyWebhookSignature({
    headers: request.headers,
    body: rawBody,
    verificationKeys,
    maxTimestampAgeMs: REPLAY_WINDOW_MS,
  });

  if (!result.ok && result.reason === "missing_key") {
    const keyId = request.headers.get("x-turnkey-signature-key-id")?.trim();
    if (keyId) {
      verificationKeys = await getTurnkeyWebhookVerificationKeysForKeyId(keyId);
      result = verifyTurnkeyWebhookSignature({
        headers: request.headers,
        body: rawBody,
        verificationKeys,
        maxTimestampAgeMs: REPLAY_WINDOW_MS,
      });
    }
  }

  if (!result.ok) {
    return { ok: false, reason: result.reason };
  }
  return { ok: true };
}

export async function POST(request: Request): Promise<Response> {
  const tag = "[turnkey-balance]";
  try {
    const rawBody = await request.text();
    console.log(tag, "POST received, body length:", sanitizeForLog(rawBody.length));

    const verified = await verifyTurnkeyWebhook(request, rawBody);
    if (!verified.ok) {
      console.warn(tag, "signature rejected:", verified.reason);
      return Response.json(
        { status: "error", reason: verified.reason },
        { status: 401 },
      );
    }
    console.log(tag, "signature verified");

    const payload = parseTurnkeyBalanceWebhookPayload(rawBody);
    if (!payload) {
      console.warn(tag, "invalid JSON payload");
      return Response.json({ status: "ignored", reason: "invalid_json" });
    }

    const config = getTurnkeyFundingConfig();
    let decision: Awaited<ReturnType<typeof shouldProcessTurnkeyDeposit>>;
    try {
      decision = await shouldProcessTurnkeyDeposit(payload, config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(tag, "shouldProcessTurnkeyDeposit threw:", message);
      return Response.json(
        { status: "error", reason: message },
        { status: 503 },
      );
    }

    if (decision.action === "skip") {
      console.log(tag, "skipped:", decision.reason);
      return Response.json({ status: "ignored", reason: decision.reason });
    }

    console.log(
      tag,
      "decision: fund",
      sanitizeForLog(decision.idempotencyKey),
      "amount:",
      sanitizeForLog(decision.amountWei.toString()),
      "fund:",
      sanitizeForLog(decision.fundWei.toString()),
    );

    const claim = await claimTurnkeyFundingEvent({
      idempotencyKey: decision.idempotencyKey,
      txHash: decision.txHash,
      address: decision.address,
      amountWei: decision.amountWei,
      fundWei: decision.fundWei,
    });

    if (claim.action === "skip") {
      console.log(tag, "claim skipped:", claim.reason);
      return Response.json({ status: "ignored", reason: claim.reason });
    }

    console.log(tag, "claimed eventId:", claim.eventId, "— calling fundDepositAndReserve");

    try {
      const allocation = await executeTurnkeyFunding(
        decision.fundWei,
        claim.eventId,
      );
      console.log(
        tag,
        "funded successfully, eventId:",
        claim.eventId,
        "deposit:",
        allocation.depositWei.toString(),
        "reserve:",
        allocation.reserveWei.toString(),
      );
      return Response.json({
        status: "funded",
        eventId: claim.eventId,
        fundedWei: decision.fundWei.toString(),
        depositWei: allocation.depositWei.toString(),
        reserveWei: allocation.reserveWei.toString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(tag, "executeTurnkeyFunding failed:", message);
      try {
        await markTurnkeyFundingFailed(claim.eventId, message);
      } catch {
        // Best-effort: preserve original funding error response.
      }
      return Response.json(
        { status: "error", reason: message, eventId: claim.eventId },
        { status: 500 },
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(tag, "unhandled error:", message);
    return Response.json(
      { status: "error", reason: message },
      { status: 500 },
    );
  }
}
