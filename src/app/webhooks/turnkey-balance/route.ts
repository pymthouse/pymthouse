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
  const rawBody = await request.text();
  const verified = await verifyTurnkeyWebhook(request, rawBody);
  if (!verified.ok) {
    return Response.json(
      { status: "error", reason: verified.reason },
      { status: 401 },
    );
  }

  const payload = parseTurnkeyBalanceWebhookPayload(rawBody);
  if (!payload) {
    return Response.json({ status: "ignored", reason: "invalid_json" });
  }

  const config = getTurnkeyFundingConfig();
  let decision: Awaited<ReturnType<typeof shouldProcessTurnkeyDeposit>>;
  try {
    decision = await shouldProcessTurnkeyDeposit(payload, config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      { status: "error", reason: message },
      { status: 503 },
    );
  }

  if (decision.action === "skip") {
    return Response.json({ status: "ignored", reason: decision.reason });
  }

  const claim = await claimTurnkeyFundingEvent({
    idempotencyKey: decision.idempotencyKey,
    txHash: decision.txHash,
    address: decision.address,
    amountWei: decision.amountWei,
    fundWei: decision.fundWei,
  });

  if (claim.action === "skip") {
    return Response.json({ status: "ignored", reason: claim.reason });
  }

  try {
    await executeTurnkeyFunding(decision.fundWei, claim.eventId);
    return Response.json({
      status: "funded",
      eventId: claim.eventId,
      fundedWei: decision.fundWei.toString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markTurnkeyFundingFailed(claim.eventId, message);
    return Response.json(
      { status: "error", reason: message, eventId: claim.eventId },
      { status: 500 },
    );
  }
}
