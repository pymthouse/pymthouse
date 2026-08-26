import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPendingUsageBillingHistoryItem,
  centsToUsdMicros,
  connectPaymentsOnlyEnabled,
  friendlyPaymentFailureMessage,
  hasOpenOrDraftInvoice,
  isMerchantConnectPaymentsReady,
  merchantConnectOnboardingLivemode,
  resolveStartMerchantConnectLivemode,
  stripePaymentMethodBrandLabel,
  sumPaidInvoiceCentsSince,
  sumSucceededStandalonePaymentCentsSince,
} from "./merchant-connect";

test("merchantConnectOnboardingLivemode defaults owner_rollup first Connect to sandbox", () => {
  assert.equal(merchantConnectOnboardingLivemode(null), false);
  assert.equal(merchantConnectOnboardingLivemode(undefined), false);
  assert.equal(
    merchantConnectOnboardingLivemode({ billingMode: "owner_rollup" }),
    false,
  );
  assert.equal(
    merchantConnectOnboardingLivemode({
      billingMode: "owner_rollup",
      stripeLivemode: false,
    }),
    false,
  );
  assert.equal(
    merchantConnectOnboardingLivemode({
      billingMode: "owner_rollup",
      stripeLivemode: true,
    }),
    true,
  );
});

test("resolveStartMerchantConnectLivemode prefers the Payments toggle until linked", () => {
  assert.equal(
    resolveStartMerchantConnectLivemode({
      requestedLivemode: true,
      config: { billingMode: "owner_rollup", stripeLivemode: false },
    }),
    true,
  );
  assert.equal(
    resolveStartMerchantConnectLivemode({
      requestedLivemode: false,
      config: { billingMode: "owner_rollup", stripeLivemode: true },
    }),
    false,
  );
  assert.equal(
    resolveStartMerchantConnectLivemode({
      config: { billingMode: "owner_rollup" },
    }),
    false,
  );
  assert.equal(
    resolveStartMerchantConnectLivemode({
      requestedLivemode: false,
      config: {
        billingMode: "owner_rollup",
        stripeConnectedAccountId: "acct_live",
        stripeLivemode: true,
      },
    }),
    true,
  );
});

test("merchantConnectOnboardingLivemode keeps stored livemode for merchant and linked accounts", () => {
  assert.equal(
    merchantConnectOnboardingLivemode({ billingMode: "merchant" }),
    true,
  );
  assert.equal(
    merchantConnectOnboardingLivemode({
      billingMode: "merchant",
      stripeLivemode: false,
    }),
    false,
  );
  assert.equal(
    merchantConnectOnboardingLivemode({
      billingMode: "owner_rollup",
      stripeConnectedAccountId: "acct_live",
    }),
    true,
  );
  assert.equal(
    merchantConnectOnboardingLivemode({
      billingMode: "owner_rollup",
      stripeConnectedAccountId: "acct_sandbox",
      stripeLivemode: false,
    }),
    false,
  );
});

test("sumPaidInvoiceCentsSince sums only paid invoices at/after the cutoff", () => {
  // This is the exact bug: a $1,000 invoice paid earlier in the cycle must
  // not still count as owed once it settles, or the meter-estimate fallback
  // reports "everything charged this cycle" instead of genuinely unbilled
  // usage — the account looks stuck in debt even right after paying it off.
  const cutoff = 1_000_000;
  assert.equal(
    sumPaidInvoiceCentsSince(
      [
        { status: "paid", created: 1_000_500, total: 100_000 }, // in window, paid
        { status: "paid", created: 999_999, total: 50_000 }, // before window
        { status: "open", created: 1_000_500, total: 25_000 }, // not paid yet
        { status: "paid", created: 1_000_500, total: null }, // no total
      ],
      cutoff,
    ),
    100_000,
  );
});

test("sumPaidInvoiceCentsSince is zero with no matching invoices", () => {
  assert.equal(sumPaidInvoiceCentsSince([], 0), 0);
  assert.equal(
    sumPaidInvoiceCentsSince([{ status: "open", created: 0, total: 500 }], 0),
    0,
  );
});

test("sumSucceededStandalonePaymentCentsSince nets Checkout top-ups, not invoice-backed PIs", () => {
  // "Add $N credit" is a succeeded PaymentIntent with no invoice. Those
  // cents must count as already paid or the meter-estimate fallback
  // reports the whole month as still owed. A PI that settled an invoice
  // is skipped so the invoice row (sumPaidInvoiceCentsSince) owns it.
  const cutoff = 1_000_000;
  assert.equal(
    sumSucceededStandalonePaymentCentsSince(
      [
        { status: "succeeded", created: 1_000_500, amount: 100_00, invoice: null },
        { status: "succeeded", created: 1_000_600, amount: 16_00, invoice: null },
        { status: "succeeded", created: 999_999, amount: 50_00, invoice: null },
        { status: "requires_payment_method", created: 1_000_500, amount: 25_00, invoice: null },
        {
          status: "succeeded",
          created: 1_000_500,
          amount: 16_00,
          invoice: "in_already_counted",
        },
        { status: "succeeded", created: 1_000_500, amount: 0, invoice: null },
      ],
      cutoff,
    ),
    116_00,
  );
});

test("sumSucceededStandalonePaymentCentsSince is zero with no matching intents", () => {
  assert.equal(sumSucceededStandalonePaymentCentsSince([], 0), 0);
  assert.equal(
    sumSucceededStandalonePaymentCentsSince(
      [{ status: "processing", created: 0, amount: 500, invoice: null }],
      0,
    ),
    0,
  );
});

test("centsToUsdMicros converts without floating point drift", () => {
  assert.equal(centsToUsdMicros(107_100), 1_071_000_000n);
  assert.equal(centsToUsdMicros(1), 10_000n);
  assert.equal(centsToUsdMicros(0), 0n);
  assert.equal(centsToUsdMicros(-5), 0n);
});

test("isMerchantConnectPaymentsReady requires account, charges, and details", () => {
  assert.equal(isMerchantConnectPaymentsReady(null), false);
  assert.equal(
    isMerchantConnectPaymentsReady({
      stripeConnectedAccountId: "acct_1",
      stripeChargesEnabled: false,
      stripeDetailsSubmitted: true,
    } as never),
    false,
  );
  assert.equal(
    isMerchantConnectPaymentsReady({
      stripeConnectedAccountId: "  ",
      stripeChargesEnabled: true,
      stripeDetailsSubmitted: true,
    } as never),
    false,
  );
  assert.equal(
    isMerchantConnectPaymentsReady({
      stripeConnectedAccountId: "acct_1",
      stripeChargesEnabled: true,
      stripeDetailsSubmitted: false,
    } as never),
    false,
  );
  assert.equal(
    isMerchantConnectPaymentsReady({
      stripeConnectedAccountId: "acct_1",
      stripeChargesEnabled: true,
      stripeDetailsSubmitted: true,
    } as never),
    true,
  );
});

test("connectPaymentsOnlyEnabled honors env override and config flag", (t) => {
  const previous = process.env.STRIPE_CONNECT_PAYMENTS_ONLY;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.STRIPE_CONNECT_PAYMENTS_ONLY;
    } else {
      process.env.STRIPE_CONNECT_PAYMENTS_ONLY = previous;
    }
  });

  delete process.env.STRIPE_CONNECT_PAYMENTS_ONLY;
  assert.equal(connectPaymentsOnlyEnabled(null), false);
  assert.equal(
    connectPaymentsOnlyEnabled({ connectPaymentsOnly: true } as never),
    true,
  );

  process.env.STRIPE_CONNECT_PAYMENTS_ONLY = "1";
  assert.equal(
    connectPaymentsOnlyEnabled({ connectPaymentsOnly: false } as never),
    true,
  );
});

test("hasOpenOrDraftInvoice only treats draft/open as live debt", () => {
  assert.equal(hasOpenOrDraftInvoice([]), false);
  assert.equal(hasOpenOrDraftInvoice([{ status: "draft" }]), true);
  assert.equal(hasOpenOrDraftInvoice([{ status: "open" }]), true);
  // Closed states must not suppress a pending row: debt accrued after an
  // invoice paid/voided/went uncollectible is genuinely new and otherwise
  // invisible.
  assert.equal(hasOpenOrDraftInvoice([{ status: "paid" }]), false);
  assert.equal(hasOpenOrDraftInvoice([{ status: "void" }]), false);
  assert.equal(hasOpenOrDraftInvoice([{ status: "uncollectible" }]), false);
  assert.equal(
    hasOpenOrDraftInvoice([{ status: "paid" }, { status: "open" }]),
    true,
  );
});

test("buildPendingUsageBillingHistoryItem is null for zero or negative debt", () => {
  assert.equal(buildPendingUsageBillingHistoryItem(0n), null);
  assert.equal(buildPendingUsageBillingHistoryItem(-1n), null);
});

test("buildPendingUsageBillingHistoryItem formats a pending row for real debt", () => {
  const now = new Date("2026-08-13T12:00:00.000Z");
  const item = buildPendingUsageBillingHistoryItem(12_340_000n, now);
  assert.deepEqual(item, {
    id: "pending_usage",
    status: "pending",
    currency: "USD",
    totalAmount: "12.34",
    issuedAt: "2026-08-13T12:00:00.000Z",
    invoiceType: "pending_usage",
  });
});

test("friendlyPaymentFailureMessage translates common decline codes", () => {
  assert.equal(friendlyPaymentFailureMessage(null), null);
  assert.equal(friendlyPaymentFailureMessage(undefined), null);
  assert.equal(
    friendlyPaymentFailureMessage({ decline_code: "insufficient_funds" }),
    "Your card was declined for insufficient funds.",
  );
  assert.equal(
    friendlyPaymentFailureMessage({ code: "expired_card" }),
    "Your card has expired.",
  );
  // decline_code wins over the generic code when both are present.
  assert.equal(
    friendlyPaymentFailureMessage({
      code: "card_declined",
      decline_code: "insufficient_funds",
    }),
    "Your card was declined for insufficient funds.",
  );
  assert.equal(
    friendlyPaymentFailureMessage({ code: "some_unrecognized_reason" }),
    "We could not charge your payment method.",
  );
});

test("stripePaymentMethodBrandLabel maps LINK and card brands", () => {
  assert.equal(stripePaymentMethodBrandLabel(null), null);
  assert.equal(stripePaymentMethodBrandLabel("pm_123"), null);
  assert.equal(
    stripePaymentMethodBrandLabel({ id: "pm_1", type: "link" }),
    "LINK",
  );
  assert.equal(
    stripePaymentMethodBrandLabel({
      id: "pm_2",
      type: "card",
      card: { brand: "visa" },
    }),
    "VISA",
  );
});
