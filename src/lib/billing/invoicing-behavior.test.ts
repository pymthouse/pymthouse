import assert from "node:assert/strict";
import test from "node:test";

import { resolvedInvoicingBehavior } from "@/lib/billing/invoicing-behavior";

test("progressive billing on with no threshold states the resolved behaviour", () => {
  // The ambiguous case: checkbox ticked, threshold field blank.
  assert.equal(
    resolvedInvoicingBehavior(true, ""),
    "On — invoicing at cycle end (no mid-cycle threshold set).",
  );
});

test("whitespace-only threshold counts as unset", () => {
  assert.equal(
    resolvedInvoicingBehavior(true, "   "),
    "On — invoicing at cycle end (no mid-cycle threshold set).",
  );
});

test("progressive billing on with a threshold names the trigger amount", () => {
  assert.equal(
    resolvedInvoicingBehavior(true, "10.00"),
    "On — invoicing mid-cycle once unpaid usage reaches $10.00.",
  );
});

test("progressive billing off ignores any leftover threshold", () => {
  assert.equal(
    resolvedInvoicingBehavior(false, "10.00"),
    "Off — usage is invoiced once, at the end of each billing cycle.",
  );
  assert.equal(
    resolvedInvoicingBehavior(false, ""),
    "Off — usage is invoiced once, at the end of each billing cycle.",
  );
});
