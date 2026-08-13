import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPendingUsageBillingHistoryItem,
  connectPaymentsOnlyEnabled,
  hasOpenOrDraftInvoice,
  isMerchantConnectPaymentsReady,
  stripePaymentMethodBrandLabel,
} from "./merchant-connect";

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
