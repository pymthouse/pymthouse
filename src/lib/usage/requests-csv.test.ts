import assert from "node:assert/strict";
import test from "node:test";

import type { SignedTicketRequestRow } from "@/lib/openmeter/signed-ticket-events";
import {
  buildRequestsCsv,
  buildRequestsCsvFilename,
  escapeCsvField,
  sumRequestFeeUsdMicros,
} from "@/lib/usage/requests-csv";

function row(overrides: Partial<SignedTicketRequestRow> = {}): SignedTicketRequestRow {
  return {
    time: "2026-07-20T10:00:00.000Z",
    clientId: "app_1",
    appName: "Demo",
    externalUserId: "user-1",
    gatewayRequestId: "req-1",
    pipeline: "byoc",
    modelId: "transcode/ffmpeg",
    networkFeeUsdMicros: "1500",
    eventId: "evt-1",
    ...overrides,
  };
}

test("escapeCsvField quotes fields containing delimiters", () => {
  assert.equal(escapeCsvField("plain"), "plain");
  assert.equal(escapeCsvField("has,comma"), '"has,comma"');
  assert.equal(escapeCsvField("has\nnewline"), '"has\nnewline"');
  assert.equal(escapeCsvField('has"quote'), '"has""quote"');
});

test("escapeCsvField neutralizes spreadsheet formula injection", () => {
  // Pipeline/model ids are operator-controlled and land in a spreadsheet.
  assert.equal(escapeCsvField("=1+1"), "'=1+1");
  assert.equal(escapeCsvField("+SUM(A1)"), "'+SUM(A1)");
  assert.equal(escapeCsvField("-2"), "'-2");
  assert.equal(escapeCsvField("@import"), "'@import");
});

test("escapeCsvField guards and quotes a hostile field together", () => {
  assert.equal(
    escapeCsvField('=HYPERLINK("http://evil","x"),y'),
    `"'=HYPERLINK(""http://evil"",""x""),y"`,
  );
});

test("escapeCsvField renders empty and missing values as blank", () => {
  assert.equal(escapeCsvField(null), "");
  assert.equal(escapeCsvField(undefined), "");
  assert.equal(escapeCsvField(""), "");
});

test("buildRequestsCsv writes a header and one line per request", () => {
  const csv = buildRequestsCsv([row(), row({ eventId: "evt-2", gatewayRequestId: "req-2" })]);
  const lines = csv.trimEnd().split("\n");

  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith("time,app,identity,request_id"));
  assert.ok(lines[1].includes("req-1"));
  assert.ok(lines[2].includes("req-2"));
  assert.ok(csv.endsWith("\n"), "file ends with a newline");
});

test("buildRequestsCsv falls back to clientId when the app has no name", () => {
  const csv = buildRequestsCsv([row({ appName: undefined })]);
  assert.ok(csv.includes("app_1"));
});

test("buildRequestsCsv emits only a header for no rows", () => {
  assert.equal(buildRequestsCsv([]), "time,app,identity,request_id,pipeline,model_id,network_fee_usd_micros,fee_wei,manifest_id\n");
});

test("sumRequestFeeUsdMicros totals exactly beyond Number precision", () => {
  const total = sumRequestFeeUsdMicros([
    row({ networkFeeUsdMicros: "9007199254740991" }),
    row({ networkFeeUsdMicros: "9007199254740991" }),
  ]);
  assert.equal(total, "18014398509481982");
});

test("sumRequestFeeUsdMicros truncates fractional micros from exact ingest", () => {
  const total = sumRequestFeeUsdMicros([
    row({ networkFeeUsdMicros: "10.932" }),
    row({ networkFeeUsdMicros: "5" }),
  ]);
  assert.equal(total, "15");
});

test("sumRequestFeeUsdMicros skips unparseable rows instead of breaking", () => {
  const total = sumRequestFeeUsdMicros([
    row({ networkFeeUsdMicros: "100" }),
    row({ networkFeeUsdMicros: "not-a-number" }),
    row({ networkFeeUsdMicros: "" }),
  ]);
  assert.equal(total, "100");
});

test("buildRequestsCsvFilename is date-stamped", () => {
  assert.equal(
    buildRequestsCsvFilename(new Date("2026-07-31T18:00:00Z")),
    "requests-2026-07-31.csv",
  );
});
