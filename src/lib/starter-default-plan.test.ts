import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultStarterIncludedUsdMicros,
  parseIncludedUsdMicros,
  planDisplayNameWithStarter,
  STARTER_DEFAULT_PLAN_DISPLAY_NAME,
} from "./starter-default-plan-display";

test("defaultStarterIncludedUsdMicros uses env or 0", () => {
  const prev = process.env.OPENMETER_DEFAULT_STARTER_INCLUDED_USD_MICROS;
  try {
    delete process.env.OPENMETER_DEFAULT_STARTER_INCLUDED_USD_MICROS;
    assert.equal(defaultStarterIncludedUsdMicros(), "0");
    process.env.OPENMETER_DEFAULT_STARTER_INCLUDED_USD_MICROS = "1000000";
    assert.equal(defaultStarterIncludedUsdMicros(), "1000000");
  } finally {
    if (prev === undefined) {
      delete process.env.OPENMETER_DEFAULT_STARTER_INCLUDED_USD_MICROS;
    } else {
      process.env.OPENMETER_DEFAULT_STARTER_INCLUDED_USD_MICROS = prev;
    }
  }
});

test("parseIncludedUsdMicros treats explicit 0 as zero, not missing", () => {
  assert.equal(parseIncludedUsdMicros("0"), 0n);
  assert.equal(parseIncludedUsdMicros("5000000"), 5_000_000n);
  assert.equal(parseIncludedUsdMicros(null), null);
  assert.equal(parseIncludedUsdMicros(""), null);
  assert.equal(parseIncludedUsdMicros("x"), null);
});

test("planDisplayNameWithStarter maps internal starter name", () => {
  assert.equal(
    planDisplayNameWithStarter({
      name: "__pymthouse_starter__",
      isStarterDefault: true,
    }),
    STARTER_DEFAULT_PLAN_DISPLAY_NAME,
  );
  assert.equal(
    planDisplayNameWithStarter({ name: "Pro", isStarterDefault: false }),
    "Pro",
  );
});
