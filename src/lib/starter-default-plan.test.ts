import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_STARTER_INCLUDED_USD_MICROS,
  defaultStarterIncludedUsdMicros,
  planDisplayNameWithStarter,
  STARTER_DEFAULT_PLAN_DISPLAY_NAME,
} from "./starter-default-plan-display";

test("defaultStarterIncludedUsdMicros is the code seed constant", () => {
  assert.equal(DEFAULT_STARTER_INCLUDED_USD_MICROS, "5000000");
  assert.equal(defaultStarterIncludedUsdMicros(), "5000000");
  // Env must not override (legacy OPENMETER_DEFAULT_STARTER_INCLUDED_USD_MICROS ignored).
  const prev = process.env.OPENMETER_DEFAULT_STARTER_INCLUDED_USD_MICROS;
  try {
    process.env.OPENMETER_DEFAULT_STARTER_INCLUDED_USD_MICROS = "1000000";
    assert.equal(defaultStarterIncludedUsdMicros(), "5000000");
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
