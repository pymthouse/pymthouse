/**
 * Merchant Connect end-user prepaid top-up Checkout session creation.
 *
 * Integration-level: hits Stripe Connected Accounts + OpenMeter customers.
 * Covered by e2e (`scripts/e2e/merchant-payments.ts`), not unit tests —
 * omitted from Sonar coverage metrics via sonar.coverage.exclusions.
 */
import { getPublicOrigin } from "@/lib/oidc/issuer-urls";
import { sanitizeForLog } from "@/lib/sanitize-for-log";
import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "@/lib/openmeter/admin-client";
import { resolveOpenMeterBillingIdentity } from "@/lib/openmeter/billing-identity";
import { getAppBillingConfig } from "@/lib/openmeter/billing-profiles";
import { ensureOpenMeterCustomer } from "@/lib/openmeter/customers";
import { createConnectedCheckoutSession } from "@/lib/stripe/connect-accounts";
import {
  appStripeLivemode,
  ensureMerchantOwnedStripeCustomer,
  isMerchantConnectPaymentsReady,
} from "@/lib/stripe/merchant-connect";
import {
  resolveTopUpReturnUrl,
  TOP_UP_MAX_USD_MICROS,
  TOP_UP_MIN_USD_MICROS,
  type TopUpCheckoutResult,
} from "@/lib/stripe/topup-checkout";

const TOP_UP_METADATA_FLAG = "pymthouse_topup";

/**
 * Create a payment-mode Checkout Session on the merchant's Connected Account
 * that credits the end-user's prepaid OM customer once paid (Connect webhook).
 */
export async function createMerchantEndUserTopUpCheckoutSession(input: {
  /** Public `app_…` client id stamped into Checkout metadata (grant routing). */
  publicClientId: string;
  /** `developer_apps.id` for `app_billing_config` / Connect account lookup. */
  appId: string;
  externalUserId: string;
  amountUsdMicros: bigint;
  successUrl?: string;
  cancelUrl?: string;
}): Promise<TopUpCheckoutResult> {
  const publicClientId = input.publicClientId.trim();
  const appId = input.appId.trim();
  const externalUserId = input.externalUserId.trim();
  if (!publicClientId || !appId || !externalUserId) {
    throw new Error("publicClientId, appId, and externalUserId are required");
  }
  if (
    input.amountUsdMicros < TOP_UP_MIN_USD_MICROS ||
    input.amountUsdMicros > TOP_UP_MAX_USD_MICROS
  ) {
    throw new Error("amountUsdMicros out of range");
  }
  if (input.amountUsdMicros % 10_000n !== 0n) {
    throw new Error("amountUsdMicros must be a whole-cent amount");
  }

  const config = await getAppBillingConfig(appId);
  if (!isMerchantConnectPaymentsReady(config)) {
    throw new Error("Merchant Stripe Connect is not ready to accept payments");
  }
  const accountId = config.stripeConnectedAccountId.trim();
  const livemode = appStripeLivemode(config);

  let openmeterCustomerId: string | undefined;
  let openmeterCustomerKey: string | undefined;
  if (isHostedAdminClientAvailable()) {
    try {
      const identity = await resolveOpenMeterBillingIdentity({
        clientId: publicClientId,
        externalUserId,
      });
      const omCustomer = await ensureOpenMeterCustomer(
        getHostedAdminClient(),
        identity.customerKey,
      );
      openmeterCustomerId = omCustomer.id;
      openmeterCustomerKey = omCustomer.key;
    } catch (err) {
      console.warn(
        "topup-checkout: OpenMeter customer ensure failed (merchant)",
        sanitizeForLog(err),
      );
    }
  }

  const stripeCustomerId = await ensureMerchantOwnedStripeCustomer({
    clientId: appId,
    externalUserId,
    accountId,
    openmeterCustomerId,
    openmeterCustomerKey,
    livemode,
  });

  const origin = getPublicOrigin();
  const success = resolveTopUpReturnUrl(
    input.successUrl,
    `${origin}/billing?topup=succeeded`,
  );
  const cancel = resolveTopUpReturnUrl(input.cancelUrl, `${origin}/billing`);
  const amountCents = Number(input.amountUsdMicros / 10_000n);

  const session = await createConnectedCheckoutSession({
    accountId,
    customerId: stripeCustomerId,
    successUrl: success,
    cancelUrl: cancel,
    mode: "payment",
    amountCents,
    currency: "usd",
    productName: "PymtHouse prepaid credits",
    applicationFeeBps: config.applicationFeeBps ?? 0,
    livemode,
    metadata: {
      [TOP_UP_METADATA_FLAG]: "1",
      client_id: publicClientId,
      external_user_id: externalUserId,
      amount_usd_micros: input.amountUsdMicros.toString(),
    },
  });

  return {
    checkoutUrl: session.url,
    sessionId: session.sessionId,
    amountUsdMicros: input.amountUsdMicros.toString(),
  };
}
