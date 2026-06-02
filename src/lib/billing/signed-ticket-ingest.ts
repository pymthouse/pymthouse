import type { SignedTicketIngestInput, SignedTicketIngestResult } from "./types";
import { recordSignedTicketToOpenMeter } from "@/lib/usage/record-signed-ticket";
import { signerProxyApiIngestEnabled } from "./feature-flags";

/**
 * Canonical signed-ticket metering entrypoint for Builder API and signer proxy.
 */
export async function ingestSignedTicketUsage(input: {
  clientId: string;
  ticket: SignedTicketIngestInput;
}): Promise<SignedTicketIngestResult> {
  const networkFeeUsdMicros = BigInt(input.ticket.networkFeeUsdMicros || "0");
  if (networkFeeUsdMicros <= 0n) {
    return {
      ingested: false,
      duplicate: false,
      source: "disabled",
    };
  }

  let omResult = { ingested: false, duplicate: false };
  if (signerProxyApiIngestEnabled()) {
    omResult = await recordSignedTicketToOpenMeter({
      clientId: input.clientId,
      externalUserId: input.ticket.externalUserId,
      requestId: input.ticket.requestId,
      networkFeeUsdMicros,
      feeWei: input.ticket.feeWei,
      pixels: input.ticket.pixels,
      pipeline: input.ticket.pipeline,
      modelId: input.ticket.modelId,
      gatewayRequestId: input.ticket.gatewayRequestId,
      ethUsdPrice: input.ticket.ethUsdPrice,
      ethUsdRoundId: input.ticket.ethUsdRoundId,
      ethUsdObservedAt: input.ticket.ethUsdObservedAt,
    });
  }

  return {
    ingested: omResult.ingested,
    duplicate: omResult.duplicate,
    source: omResult.ingested ? "openmeter" : "disabled",
  };
}
