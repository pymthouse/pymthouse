import assert from "node:assert/strict";
import test from "node:test";

import { resolveSoftNegativeGate } from "@/lib/billing/soft-negative-gate";
import { getUnbilledDebtUsdMicros } from "@/lib/billing/unbilled-debt";

test("resolveSoftNegativeGate allows when spendable is positive", async () => {
  const result = await resolveSoftNegativeGate({
    clientId: "app_soft_neg",
    externalUserId: "eu_1",
    spendableUsdMicros: 1n,
    allowsOverageInvoicing: false,
  });
  assert.deepEqual(result, {
    allow: true,
    unbilledDebtUsdMicros: 0n,
    softNegativeUsdMicros: 0n,
  });
});

test("resolveSoftNegativeGate denies when overage is not allowed", async () => {
  const result = await resolveSoftNegativeGate({
    clientId: "app_soft_neg",
    externalUserId: "eu_1",
    spendableUsdMicros: 0n,
    allowsOverageInvoicing: false,
  });
  assert.deepEqual(result, {
    allow: false,
    unbilledDebtUsdMicros: 0n,
    softNegativeUsdMicros: 0n,
  });
});

test("resolveSoftNegativeGate allows overage when soft-negative ceiling is unset", async () => {
  const result = await resolveSoftNegativeGate({
    clientId: "app_missing_soft_neg",
    externalUserId: "eu_1",
    spendableUsdMicros: 0n,
    allowsOverageInvoicing: true,
  });
  assert.equal(result.allow, true);
  assert.equal(result.softNegativeUsdMicros, 0n);
  assert.equal(result.unbilledDebtUsdMicros, 0n);
});

test("getUnbilledDebtUsdMicros returns 0 when OpenMeter is unavailable", async (t) => {
  const prevUrl = process.env.OPENMETER_URL;
  const prevKey = process.env.OPENMETER_API_KEY;
  t.after(() => {
    if (prevUrl === undefined) delete process.env.OPENMETER_URL;
    else process.env.OPENMETER_URL = prevUrl;
    if (prevKey === undefined) delete process.env.OPENMETER_API_KEY;
    else process.env.OPENMETER_API_KEY = prevKey;
  });
  delete process.env.OPENMETER_URL;
  delete process.env.OPENMETER_API_KEY;

  assert.equal(
    await getUnbilledDebtUsdMicros({
      clientId: "app_debt",
      externalUserId: "eu_1",
    }),
    0n,
  );
  assert.equal(
    await getUnbilledDebtUsdMicros({
      clientId: "  ",
      externalUserId: "eu_1",
    }),
    0n,
  );
});
