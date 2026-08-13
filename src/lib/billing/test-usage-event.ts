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

type TestUsageEventDeps = {
  isHostedAdminClientAvailable: typeof isHostedAdminClientAvailable;
  parseTopUpAmountUsd: typeof parseTopUpAmountUsd;
  getHostedAdminClient: typeof getHostedAdminClient;
  ensureOpenMeterCustomerForAppUser: typeof ensureOpenMeterCustomerForAppUser;
  ingestSignedTicketEvent: typeof ingestSignedTicketEvent;
  invoiceGatheringForIdentity: typeof invoiceGatheringForIdentity;
  formatUsdMicrosForDisplay: typeof formatUsdMicrosForDisplay;
  randomUUID: typeof randomUUID;
  sleep: (ms: number) => Promise<void>;
};

const DEFAULT_TEST_USAGE_EVENT_DEPS: TestUsageEventDeps = {
  isHostedAdminClientAvailable,
  parseTopUpAmountUsd,
  getHostedAdminClient,
  ensureOpenMeterCustomerForAppUser,
  ingestSignedTicketEvent,
  invoiceGatheringForIdentity,
  formatUsdMicrosForDisplay,
  randomUUID,
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
};

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
  /**
   * Force a mid-cycle invoice raise after ingest settles. Opt-in — ingesting
   * usage and demanding immediate collection are separate actions; forcing
   * on every call regardless of caller intent is what produced repeated
   * collisions with an already-unresolved invoicing run for the same
   * customer back when this called OpenMeter directly. Settlement's
   * per-customer Kafka lane now absorbs that collision instead (see
   * invoice-trigger's `"queued"` outcome), but the opt-in stays: ingesting
   * usage and demanding immediate collection are still separate actions.
   * Callers that want the old always-collect behavior should pass
   * `collect: true` explicitly.
   */
  collect?: boolean;
}, deps: TestUsageEventDeps = DEFAULT_TEST_USAGE_EVENT_DEPS): Promise<TestUsageEventResult> {
  if (!deps.isHostedAdminClientAvailable()) {
    throw new Error("OpenMeter is not configured");
  }

  const amount = deps.parseTopUpAmountUsd(input.amountUsd);
  if (!amount.ok) {
    throw new Error(amount.error);
  }

  const externalUserId = input.externalUserId.trim();
  const publicClientId = input.publicClientId.trim();
  if (!externalUserId || !publicClientId) {
    throw new Error("publicClientId and externalUserId are required");
  }

  const client = deps.getHostedAdminClient();
  await deps.ensureOpenMeterCustomerForAppUser({
    client,
    clientId: publicClientId,
    externalUserId,
  });

  const requestId = `test-usage-${deps.randomUUID()}`;
  const amountUsdMicros = amount.amountUsdMicros.toString();

  await deps.ingestSignedTicketEvent({
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
    amountUsd: deps.formatUsdMicrosForDisplay(amountUsdMicros),
    subject: `${publicClientId}:${externalUserId}`,
    collected: false,
  };

  if (input.collect === false) {
    return result;
  }

  // Metering is eventually consistent; brief pause before forcing collection.
  await deps.sleep(INGEST_SETTLE_MS);

  const collect = await deps.invoiceGatheringForIdentity({
    clientId: publicClientId,
    externalUserId,
    force: true,
  });

  return {
    ...result,
    // "queued" means settlement accepted the raise onto its Kafka lane, not
    // that an invoice exists yet — see invoice-trigger's outcome doc comment.
    collected: collect.outcome === "queued",
    collect,
  };
}
