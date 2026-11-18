/**
 * Merchant Connect Checkout session creation (setup mode).
 *
 * Integration-level: hits Stripe Connected Accounts + app billing config.
 * Covered by e2e (`scripts/e2e/merchant-payments.ts`), not unit tests —
 * omitted from Sonar coverage metrics via sonar.coverage.exclusions.
 */
import { getAppBillingConfig } from "@/lib/openmeter/billing-profiles";
import { createConnectedCheckoutSession } from "@/lib/stripe/connect-accounts";
import {
  appStripeLivemode,
  ensureMerchantOwnedStripeCustomer,
  isMerchantConnectPaymentsReady,
} from "@/lib/stripe/merchant-connect";

export async function createMerchantConnectCheckoutForUser(input: {
  clientId: string;
  externalUserId: string;
  successUrl: string;
  cancelUrl: string;
  openmeterCustomerId?: string;
  openmeterCustomerKey?: string;
}): Promise<{ checkoutUrl: string; sessionId: string }> {
  const config = await getAppBillingConfig(input.clientId);
  if (!isMerchantConnectPaymentsReady(config)) {
    throw new Error("Merchant Stripe Connect is not ready to accept payments");
  }
  const accountId = config.stripeConnectedAccountId.trim();
  const livemode = appStripeLivemode(config);
  const customerId = await ensureMerchantOwnedStripeCustomer({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
    accountId,
    openmeterCustomerId: input.openmeterCustomerId,
    openmeterCustomerKey: input.openmeterCustomerKey,
    livemode,
  });
  const session = await createConnectedCheckoutSession({
    accountId,
    customerId,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
    mode: "setup",
    currency: config.defaultCurrency ?? "usd",
    applicationFeeBps: config.applicationFeeBps ?? 0,
    livemode,
    metadata: {
      pymthouse_client_id: input.clientId,
      external_user_id: input.externalUserId,
    },
  });
  return { checkoutUrl: session.url, sessionId: session.sessionId };
}
