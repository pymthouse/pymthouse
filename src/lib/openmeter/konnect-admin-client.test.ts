import assert from "node:assert/strict";
import { test } from "node:test";
import { toKonnectApiUrl } from "./konnect-admin-client";

test("toKonnectApiUrl resolves relative paths on the configured origin", () => {
  assert.equal(
    toKonnectApiUrl("https://us.api.konghq.com/v3/openmeter", "/customers/c_1"),
    "https://us.api.konghq.com/v3/openmeter/customers/c_1",
  );
  assert.equal(
    toKonnectApiUrl("https://us.api.konghq.com/metering/v1", "/subscriptions/s_1"),
    "https://us.api.konghq.com/metering/v1/subscriptions/s_1",
  );
});

test("toKonnectApiUrl allows local OpenMeter hosts", () => {
  assert.equal(
    toKonnectApiUrl("http://127.0.0.1:48888/v3/openmeter", "/meters"),
    "http://127.0.0.1:48888/v3/openmeter/meters",
  );
});

test("toKonnectApiUrl rejects host/scheme injection", () => {
  assert.throws(
    () => toKonnectApiUrl("https://us.api.konghq.com/v3/openmeter", "https://evil.example/x"),
    /Invalid Konnect API path/,
  );
  assert.throws(
    () => toKonnectApiUrl("https://us.api.konghq.com/v3/openmeter", "//evil.example/x"),
    /Invalid Konnect API path/,
  );
  assert.throws(
    () => toKonnectApiUrl("https://us.api.konghq.com/v3/openmeter", "/../escape"),
    /Invalid Konnect API path/,
  );
  assert.throws(
    () => toKonnectApiUrl("https://us.api.konghq.com/v3/openmeter", "customers"),
    /Invalid Konnect API path/,
  );
});

test("toKonnectApiUrl rejects non-Konnect remote hosts", () => {
  assert.throws(
    () => toKonnectApiUrl("https://evil.example/v3/openmeter", "/customers"),
    /not allowlisted/,
  );
});
