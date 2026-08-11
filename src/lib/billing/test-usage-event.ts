/**
 * Demo/test path: ingest a create_signed_ticket CloudEvent with an exact
 * USD-micros fee so OpenMeter metering → progressive invoice → Custom
 * Invoicing / Stripe Connect can be exercised without a live gateway.
 */
import { randomUUID } from "node:crypto";

import {
  invoiceGatheringForIdentity,
  type InvoiceTriggerResult,
} from "@/lib/billing/invoice-trigger";
import { formatUsdMicrosForDisplay } from "@/lib/billing/pay-per-use-threshold";
import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "@/lib/openmeter/admin-client";
import { ensureOpenMeterCustomerForAppUser } from "@/lib/openmeter/customers";
import { ingestSignedTicketEvent } from "@/lib/openmeter/entitlements";
import { parseTopUpAmountUsd } from "@/lib/stripe/topup-checkout";

const INGEST_SETTLE_MS = 2_500;

export type TestUsageEventResult = {
  requestId: string;
  amountUsdMicros: string;
  amountUsd: string;
  subject: string;
  collected: boolean;
  collect?: InvoiceTriggerResult;
};

export async function ingestTestUsageEvent(input: {
  publicClientId: string;
  externalUserId: string;
  amountUsd: unknown;
  /** When true, force mid-cycle invoice raise after ingest settles. */
  collect?: boolean;
}): Promise<TestUsageEventResult> {
  if (!isHostedAdminClientAvailable()) {
    throw new Error("OpenMeter is not configured");
  }

  const amount = parseTopUpAmountUsd(input.amountUsd);
  if (!amount.ok) {
    throw new Error(amount.error);
  }

  const externalUserId = input.externalUserId.trim();
  const publicClientId = input.publicClientId.trim();
  if (!externalUserId || !publicClientId) {
    throw new Error("publicClientId and externalUserId are required");
  }

  const client = getHostedAdminClient();
  await ensureOpenMeterCustomerForAppUser({
    client,
    clientId: publicClientId,
    externalUserId,
  });

  const requestId = `test-usage-${randomUUID()}`;
  const amountUsdMicros = amount.amountUsdMicros.toString();

  await ingestSignedTicketEvent({
    client,
    event: {
      clientId: publicClientId,
      externalUserId,
      requestId,
      networkFeeUsdMicros: amountUsdMicros,
      pipeline: "live-video-to-video",
      modelId: "noop",
      manifestId: `test-usage-${requestId.slice(0, 18)}`,
      billableSecs: 1,
      pixels: "0",
      gatewayRequestId: requestId,
      ethUsdPrice: "test",
    },
  });

  const result: TestUsageEventResult = {
    requestId,
    amountUsdMicros,
    amountUsd: formatUsdMicrosForDisplay(amountUsdMicros),
    subject: `${publicClientId}:${externalUserId}`,
    collected: false,
  };

  if (input.collect === false) {
    return result;
  }

  // Metering is eventually consistent; brief pause before forcing collection.
  await new Promise((resolve) => setTimeout(resolve, INGEST_SETTLE_MS));

  const collect = await invoiceGatheringForIdentity({
    clientId: publicClientId,
    externalUserId,
    force: true,
  });

  return {
    ...result,
    collected: true,
    collect,
  };
}
