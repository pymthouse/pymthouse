import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultStarterIncludedUsdMicros,
  planDisplayNameWithStarter,
  STARTER_DEFAULT_PLAN_DISPLAY_NAME,
} from "./starter-default-plan-display";

test("defaultStarterIncludedUsdMicros uses env or 5000000", () => {
  const prev = process.env.OPENMETER_DEFAULT_STARTER_INCLUDED_USD_MICROS;
  try {
    delete process.env.OPENMETER_DEFAULT_STARTER_INCLUDED_USD_MICROS;
    assert.equal(defaultStarterIncludedUsdMicros(), "5000000");
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
