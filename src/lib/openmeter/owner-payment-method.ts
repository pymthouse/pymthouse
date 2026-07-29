import { getPublicOrigin } from "@/lib/oidc/issuer-urls";
import { getHostedAdminClient } from "./admin-client";
import { prepareOwnerCustomerStripeBilling } from "./billing-profiles";
import {
  ensureOwnerCustomer,
  listOwnedPublicClientIds,
} from "./customers";
import { getKonnectDefaultPaymentMethodId } from "./stripe-customer-data";

export type OwnerPaymentMethodCheckoutResult = {
  checkoutUrl: string;
  sessionId: string | null;
  customerId: string;
  /** True when Konnect already has a default payment method on file. */
  hasDefaultPaymentMethod: boolean;
};

/**
 * Start an OpenMeter Stripe Checkout session (always setup mode) so the owner
 * can attach a card for Plane A overage invoices (charge_automatically).
 */
export async function createOwnerPaymentMethodCheckout(input: {
  ownerUserId: string;
  successUrl?: string;
  cancelUrl?: string;
}): Promise<OwnerPaymentMethodCheckoutResult> {
  const ownerUserId = input.ownerUserId.trim();
  if (!ownerUserId) {
    throw new Error("ownerUserId is required");
  }

  const client = getHostedAdminClient();
  const publicClientIds = await listOwnedPublicClientIds(ownerUserId);
  const customer = await ensureOwnerCustomer(
    client,
    ownerUserId,
    publicClientIds,
  );
  await prepareOwnerCustomerStripeBilling({
    client,
    customerId: customer.id,
    customerKey: customer.key,
  });

  const defaultPm = await getKonnectDefaultPaymentMethodId(customer.id);
  const origin = getPublicOrigin();
  const success =
    input.successUrl?.trim() || `${origin}/billing?pm=attached`;
  const cancel = input.cancelUrl?.trim() || `${origin}/billing`;

  const checkout = await client.apps.stripe.createCheckoutSession({
    customer: { id: customer.id },
    options: {
      successURL: success,
      cancelURL: cancel,
      currency: "USD",
    },
  });
  if (!checkout?.url) {
    throw new Error("Stripe checkout session URL unavailable");
  }

  return {
    checkoutUrl: checkout.url,
    sessionId: checkout.sessionId ?? null,
    customerId: customer.id,
    hasDefaultPaymentMethod: Boolean(defaultPm),
  };
}
