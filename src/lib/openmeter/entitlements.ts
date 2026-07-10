import type { OpenMeter } from "@openmeter/sdk";
import {
  CREATE_SIGNED_TICKET_EVENT_TYPE,
  getHostedOpenMeterUrl,
  NETWORK_FEE_USD_NANOS_METER,
  SIGNED_TICKET_COUNT_METER,
  SIGNED_TICKET_EVENT_SOURCE,
  usdMicrosToNanos,
  usdNanosToMicros,
} from "./constants";
import { buildOpenMeterCustomerKey } from "./customer-key";
import { ensureOpenMeterCustomer } from "./customers";
import {
  getHostedTrialOpenMeterClient,
  getTrialFeatureKeyForApp,
} from "./client-factory";
import { defaultStarterIncludedUsdMicros } from "@/lib/starter-default-plan-display";
import { getKonnectEntitlementHasAccess } from "./konnect-entitlements";
import { shouldUseKonnectRoutes } from "./route-mode";
import {
  getPrimaryOpenMeterSubscriptionForAppUser,
  isOpenMeterSubscriptionActive,
} from "./subscription-read";
import { queryOpenMeterUsage } from "./usage-read";

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
      // OpenMeter meter is USD nanos; app grants stay in micros.
      amount: Number(usdMicrosToNanos(input.amountUsdMicros)),
      priority: 1,
      effectiveAt: new Date(),
      expiration: { duration: "YEAR", count: 1 },
    },
  );
}

/**
 * Konnect's entitlement-access endpoint only reports a boolean; it never
 * surfaces the consumed amount. Derive consumption from the signer-backed
 * network-fee meter (the same meter the usage dashboard reads) so the trial
 * allowance actually draws down. The trial grant is a one-year credit, so a
 * 365-day lookback safely bounds the meter query when the subscription start
 * is unknown.
 */
async function sumKonnectNetworkFeeUsdMicros(input: {
  clientId: string;
  externalUserId: string;
  startDate?: string | null;
}): Promise<bigint> {
  const startDate =
    input.startDate ||
    new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
  const rows = await queryOpenMeterUsage({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
    startDate,
    endDate: new Date().toISOString(),
  });
  let total = 0n;
  for (const row of rows) {
    total += BigInt(row.networkFeeUsdMicros || "0");
  }
  return total;
}

async function getKonnectTrialCreditBalance(input: {
  clientId: string;
  externalUserId: string;
  customerId: string;
  featureKey: string;
  apiKey?: string;
}): Promise<TrialCreditBalance | null> {
  let hasAccess = await getKonnectEntitlementHasAccess({
    customerId: input.customerId,
    featureKey: input.featureKey,
    apiKey: input.apiKey,
  });
  if (hasAccess === null) {
    return null;
  }

  let periodStart: string | null = null;
  if (!hasAccess) {
    const starterSubscription = await getPrimaryOpenMeterSubscriptionForAppUser({
      clientId: input.clientId,
      externalUserId: input.externalUserId,
    });
    if (starterSubscription && isOpenMeterSubscriptionActive(starterSubscription.status)) {
      // Konnect plan rate_cards.discounts.usage does not always surface in
      // entitlement-access; an active starter subscription implies included trial usage.
      //
      // Known limitation: this assumes subscription existence implies provisioned
      // trial credits. If a subscription exists but credits were never granted
      // (e.g. plan sync or discount misconfiguration), the grant below is assumed
      // present. Monitor until Konnect surfaces the discount in entitlement-access.
      hasAccess = true;
      periodStart = starterSubscription.activeFrom;
    }
  }

  const defaultGrant = defaultStarterIncludedUsdMicros();
  if (!hasAccess) {
    return {
      hasAccess: false,
      balanceUsdMicros: "0",
      consumedUsdMicros: "0",
      lifetimeGrantedUsdMicros: "0",
    };
  }

  const grant = BigInt(defaultGrant);
  const consumed = await sumKonnectNetworkFeeUsdMicros({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
    startDate: periodStart,
  });
  const balance = consumed >= grant ? 0n : grant - consumed;

  return {
    hasAccess: balance > 0n,
    balanceUsdMicros: balance.toString(),
    consumedUsdMicros: consumed.toString(),
    lifetimeGrantedUsdMicros: defaultGrant,
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

  const customerKey = buildOpenMeterCustomerKey(input.clientId, input.externalUserId);
  const featureKey = input.featureKey || (await getTrialFeatureKeyForApp(input.clientId));

  const customer = await ensureOpenMeterCustomer(client, customerKey);
  const apiKey = process.env.OPENMETER_API_KEY?.trim();

  if (shouldUseKonnectRoutes(getHostedOpenMeterUrl(), apiKey)) {
    return getKonnectTrialCreditBalance({
      clientId: input.clientId,
      externalUserId: input.externalUserId,
      customerId: customer.id,
      featureKey,
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

  const balance = Math.max(
    0,
    Number(usdNanosToMicros(BigInt(Math.floor(value.balance ?? 0)))),
  );
  const usage = Math.max(
    0,
    Number(usdNanosToMicros(BigInt(Math.floor(value.usage ?? 0)))),
  );
  const granted = Math.max(
    0,
    Number(
      usdNanosToMicros(
        BigInt(Math.floor(value.totalAvailableGrantAmount ?? (value.balance ?? 0) + (value.usage ?? 0))),
      ),
    ),
  );

  return {
    hasAccess: Boolean(value.hasAccess) && balance > 0,
    balanceUsdMicros: String(balance),
    consumedUsdMicros: String(usage),
    lifetimeGrantedUsdMicros: String(granted),
  };
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
  const subject = buildOpenMeterCustomerKey(input.event.clientId, usageSubject);

  await input.client.events.ingest({
    specversion: "1.0",
    type: CREATE_SIGNED_TICKET_EVENT_TYPE,
    id: input.event.requestId,
    source: SIGNED_TICKET_EVENT_SOURCE,
    subject,
    data: {
      client_id: input.event.clientId,
      usage_subject: usageSubject,
      usage_subject_type: "external_user_id",
      external_user_id: usageSubject,
      network_fee_usd_nanos: Number(
        usdMicrosToNanos(BigInt(input.event.networkFeeUsdMicros || "0")),
      ),
      fee_wei: input.event.feeWei,
      pixels: input.event.pixels,
      pipeline: input.event.pipeline || "unknown",
      model_id: input.event.modelId || "unknown",
      gateway_request_id: input.event.gatewayRequestId,
      eth_usd_price: input.event.ethUsdPrice,
      eth_usd_round_id: input.event.ethUsdRoundId,
      eth_usd_observed_at: input.event.ethUsdObservedAt,
      auth_id: subject,
    },
  });
}

export const OPENMETER_METER_DEFINITIONS = [
  {
    slug: NETWORK_FEE_USD_NANOS_METER,
    description:
      "Livepeer signed-ticket network fee (USD nanos; 1 USD = 1e9) — SUM of collector network_fee_usd_nanos; grouped by client, user, pipeline, model",
    eventType: CREATE_SIGNED_TICKET_EVENT_TYPE,
    aggregation: "SUM" as const,
    valueProperty: "$.network_fee_usd_nanos",
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
  NETWORK_FEE_USD_NANOS_METER,
  SIGNED_TICKET_COUNT_METER,
} from "./constants";
