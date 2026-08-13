import assert from "node:assert/strict";
import test from "node:test";
import { getOwnerBillingData } from "@/lib/owner-billing-data";

test("owner billing accepts explicit owner id without session scope", async () => {
  const result = await getOwnerBillingData("   owner-for-test   ");
  assert.deepEqual(result, { ok: false, reason: "openmeter_unconfigured" });
});

test("owner billing reads session when owner id is omitted", async () => {
  await assert.rejects(
    async () => getOwnerBillingData(),
    /outside a request scope/,
  );
});
