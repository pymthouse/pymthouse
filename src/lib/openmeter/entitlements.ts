import type { OpenMeter } from "@openmeter/sdk";
import {
  CREATE_SIGNED_TICKET_EVENT_TYPE,
  getHostedOpenMeterUrl,
  NETWORK_FEE_USD_MICROS_METER,
  SIGNED_TICKET_COUNT_METER,
  SIGNED_TICKET_EVENT_SOURCE,
} from "./constants";
import { buildOpenMeterCustomerKey } from "./customer-key";
import { ensureOpenMeterCustomer } from "./customers";
import {
  getHostedTrialOpenMeterClient,
  getTrialFeatureKeyForApp,
} from "./client-factory";
import { getKonnectCreditBalance } from "./konnect-credits";
import { shouldUseKonnectRoutes } from "./route-mode";

export type { OpenMeterCustomerIdentity } from "./customers";
export { ensureOpenMeterCustomer } from "./customers";

export type TrialCreditBalance = {
  hasAccess: boolean;
  balanceUsdMicros: string;
  consumedUsdMicros: string;
  lifetimeGrantedUsdMicros: string;
};

export async function grantTrialCredits(input: {
  client: OpenMeter;
  customerKey: string;
  featureKey: string;
  amountUsdMicros: bigint;
}): Promise<void> {
  await input.client.customers.entitlements.createGrant(
    input.customerKey,
    input.featureKey,
    {
      amount: Number(input.amountUsdMicros),
      priority: 1,
      effectiveAt: new Date(),
      expiration: { duration: "YEAR", count: 1 },
    },
  );
}

/** Konnect prepaid credits ledger (GET /credits/balance + grants list). */
async function getKonnectTrialCreditBalance(input: {
  customerId: string;
  apiKey?: string;
}): Promise<TrialCreditBalance | null> {
  const credits = await getKonnectCreditBalance({
    customerId: input.customerId,
    apiKey: input.apiKey,
  });
  if (!credits) {
    return null;
  }

  return {
    hasAccess: credits.balanceUsdMicros > 0n,
    balanceUsdMicros: credits.balanceUsdMicros.toString(),
    consumedUsdMicros: credits.consumedUsdMicros.toString(),
    lifetimeGrantedUsdMicros: credits.lifetimeGrantedUsdMicros.toString(),
  };
}

export async function getTrialCreditBalance(input: {
  clientId: string;
  externalUserId: string;
  featureKey?: string;
}): Promise<TrialCreditBalance | null> {
  const client = getHostedTrialOpenMeterClient();
  if (!client) {
    return null;
  }

  const { resolveOpenMeterBillingIdentity } = await import(
    "@/lib/openmeter/billing-identity"
  );
  const identity = await resolveOpenMeterBillingIdentity({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });
  const customerKey = identity.customerKey;
  const featureKey =
    input.featureKey || (await getTrialFeatureKeyForApp(identity.developerAppId));

  const customer = await ensureOpenMeterCustomer(client, customerKey);
  const apiKey = process.env.OPENMETER_API_KEY?.trim();

  if (shouldUseKonnectRoutes(getHostedOpenMeterUrl(), apiKey)) {
    return getKonnectTrialCreditBalance({
      customerId: customer.id,
      apiKey,
    });
  }

  const value = await client.customers.entitlements.value(customerKey, featureKey);
  if (!value) {
    return {
      hasAccess: false,
      balanceUsdMicros: "0",
      consumedUsdMicros: "0",
      lifetimeGrantedUsdMicros: "0",
    };
  }

  // Keep integer micros (including 1–99) so the mint gate matches Konnect/collector.
  const balance = entitlementAmountToMicros(value.balance);
  const usage = entitlementAmountToMicros(value.usage);
  const grantedRaw = value.totalAvailableGrantAmount;
  const granted =
    grantedRaw == null ? balance + usage : entitlementAmountToMicros(grantedRaw);

  return {
    hasAccess: balance > 0n,
    balanceUsdMicros: balance.toString(),
    consumedUsdMicros: usage.toString(),
    lifetimeGrantedUsdMicros: granted.toString(),
  };
}

/** Parse self-hosted OpenMeter entitlement amounts into non-negative USD micros. */
function entitlementAmountToMicros(value: unknown): bigint {
  if (value == null) return 0n;
  if (typeof value === "bigint") return value > 0n ? value : 0n;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return 0n;
    return BigInt(Math.trunc(value));
  }
  if (typeof value === "string") {
    const t = value.trim();
    if (!t) return 0n;
    if (/^\d+$/.test(t)) {
      try {
        return BigInt(t);
      } catch {
        return 0n;
      }
    }
    const parsed = Number(t);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0n;
    return BigInt(Math.trunc(parsed));
  }
  return 0n;
}

export type SignedTicketOpenMeterEvent = {
  requestId: string;
  clientId: string;
  externalUserId: string;
  networkFeeUsdMicros: string;
  feeWei?: string;
  pixels?: string;
  pipeline?: string;
  modelId?: string;
  gatewayRequestId?: string;
  ethUsdPrice?: string;
  ethUsdRoundId?: string;
  ethUsdObservedAt?: string;
};

export async function ingestSignedTicketEvent(input: {
  client: OpenMeter;
  event: SignedTicketOpenMeterEvent;
}): Promise<void> {
  const usageSubject = input.event.externalUserId.trim();
  const { resolveOpenMeterBillingIdentity } = await import(
    "@/lib/openmeter/billing-identity"
  );
  const identity = await resolveOpenMeterBillingIdentity({
    clientId: input.event.clientId,
    externalUserId: usageSubject,
  });
  // Wire auth_id stays compound app_…:platformUserId for analytics.
  // CloudEvent subject must be the Konnect customer key for owners
  // (owner:{id}) — Konnect billing beta clears multi-subject attribution
  // when a subscription is created, so compound subjects cannot settle.
  const platformUserId = identity.isOwner
    ? (identity.ownerUserId as string)
    : usageSubject;
  const wireAuthId = buildOpenMeterCustomerKey(
    identity.publicClientId,
    platformUserId,
  );
  const meterSubject = identity.customerKey;

  await input.client.events.ingest({
    specversion: "1.0",
    type: CREATE_SIGNED_TICKET_EVENT_TYPE,
    id: input.event.requestId,
    source: SIGNED_TICKET_EVENT_SOURCE,
    subject: meterSubject,
    data: {
      client_id: identity.publicClientId,
      usage_subject: platformUserId,
      usage_subject_type: identity.isOwner ? "app_owner" : "external_user_id",
      external_user_id: platformUserId,
      network_fee_usd_micros: Number(input.event.networkFeeUsdMicros),
      fee_wei: input.event.feeWei,
      pixels: input.event.pixels,
      pipeline: input.event.pipeline || "unknown",
      model_id: input.event.modelId || "unknown",
      gateway_request_id: input.event.gatewayRequestId,
      eth_usd_price: input.event.ethUsdPrice,
      eth_usd_round_id: input.event.ethUsdRoundId,
      eth_usd_observed_at: input.event.ethUsdObservedAt,
      auth_id: wireAuthId,
      openmeter_customer_key: identity.customerKey,
    },
  });
}

export const OPENMETER_METER_DEFINITIONS = [
  {
    slug: NETWORK_FEE_USD_MICROS_METER,
    description:
      "Livepeer signed-ticket network fee (USD micros) — SUM of signer computed_fee_usd_micros; grouped by client, user, pipeline, model",
    eventType: CREATE_SIGNED_TICKET_EVENT_TYPE,
    aggregation: "SUM" as const,
    valueProperty: "$.network_fee_usd_micros",
    groupBy: {
      client_id: "$.client_id",
      external_user_id: "$.external_user_id",
      pipeline: "$.pipeline",
      model_id: "$.model_id",
    },
  },
  {
    slug: SIGNED_TICKET_COUNT_METER,
    description: "Signed ticket count per user",
    eventType: CREATE_SIGNED_TICKET_EVENT_TYPE,
    aggregation: "COUNT" as const,
    groupBy: {
      client_id: "$.client_id",
      external_user_id: "$.external_user_id",
      pipeline: "$.pipeline",
      model_id: "$.model_id",
    },
  },
];

export {
  DEFAULT_TRIAL_FEATURE_KEY,
  NETWORK_FEE_USD_MICROS_METER,
  SIGNED_TICKET_COUNT_METER,
} from "./constants";
