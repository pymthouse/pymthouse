import test from "node:test";
import assert from "node:assert/strict";
import { classifyConnectCutoverFindings } from "./connect-cutover";

test("classifyConnectCutoverFindings flags missing account for paid plans", () => {
  const findings = classifyConnectCutoverFindings({
    clientId: "app_x",
    hasPaidActivePlan: true,
    stripeConnectedAccountId: null,
    stripeChargesEnabled: false,
    connectPaymentsOnly: false,
    mappedCustomerCount: 0,
  });
  assert.equal(findings.some((f) => f.code === "connect_account_missing"), true);
});

test("classifyConnectCutoverFindings quiet when ready", () => {
  const findings = classifyConnectCutoverFindings({
    clientId: "app_x",
    hasPaidActivePlan: true,
    stripeConnectedAccountId: "acct_1",
    stripeChargesEnabled: true,
    connectPaymentsOnly: true,
    mappedCustomerCount: 3,
  });
  assert.equal(findings.length, 0);
});
