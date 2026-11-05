import assert from "node:assert/strict";
import test from "node:test";

import { buildUsageTotals, parseUsageQuery } from "./app-usage";

test("parseUsageQuery validates startDate", () => {
  const result = parseUsageQuery(new URL("http://localhost/usage?startDate=nope"));
  assert.equal(result.ok, false);
  assert.equal(result.ok ? "" : result.body.error, "Invalid startDate format");
});

test("parseUsageQuery reads supported grouping and filters", () => {
  const result = parseUsageQuery(
    new URL("http://localhost/usage?groupBy=user&userId=u1&gatewayRequestId=gw1"),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.value : null, {
    startDate: null,
    endDate: null,
    groupBy: "user",
    filterUserId: "u1",
    filterGatewayRequestId: "gw1",
  });
});

test("buildUsageTotals joins event metrics by usage record id", () => {
  const totals = buildUsageTotals({
    usageRows: [
      { id: "u1", fee: "10" },
      { id: "u2", fee: "20" },
    ],
    eventByUsageRecord: new Map([
      [
        "u1",
        {
          networkFeeUsdMicros: "100",
          ownerChargeWei: "3",
          ownerChargeUsdMicros: "120",
          platformFeeWei: "1",
          endUserBillableUsdMicros: "140",
        },
      ],
    ]),
  });
  assert.equal(totals.requestCount, 2);
  assert.equal(totals.totalFeeWei, "30");
  assert.equal(totals.networkFeeUsdMicros, "100");
  assert.equal(totals.platformFeeWei, "1");
});
