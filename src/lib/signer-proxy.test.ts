import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  getClientSignerApiUrl,
  getLatestSignerApps,
  getSignerVersionForApp,
  isLatestSignerApp,
} from "@/lib/signer-proxy";

// Env vars that steer stable vs latest signer resolution. Snapshot + restore so
// tests do not leak into each other or into DB-backed suites.
const TOUCHED = [
  "PYMTHOUSE_CLIENT_SIGNER_API_URL",
  "PYMTHOUSE_SIGNER_URL",
  "SIGNER_PUBLIC_URL",
  "SIGNER_INTERNAL_URL",
  "PYMTHOUSE_TEST_SIGNER_URL",
  "SIGNER_LATEST_URL",
  "LATEST_SIGNER_APPS",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of TOUCHED) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  // Deterministic stable URL for every test in this file.
  process.env.PYMTHOUSE_SIGNER_URL = "https://stable.example";
});

afterEach(() => {
  for (const key of TOUCHED) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
});

test("getLatestSignerApps parses comma/space separated ids and drops empties", () => {
  process.env.LATEST_SIGNER_APPS = " app_123, app_234 ,, app_345 ";
  assert.deepEqual(
    [...getLatestSignerApps()].sort(),
    ["app_123", "app_234", "app_345"],
  );
});

test("getLatestSignerApps is empty when unset", () => {
  assert.equal(getLatestSignerApps().size, 0);
});

test("isLatestSignerApp only matches listed ids", () => {
  process.env.LATEST_SIGNER_APPS = "app_123,app_234";
  assert.equal(isLatestSignerApp("app_123"), true);
  assert.equal(isLatestSignerApp("app_999"), false);
  assert.equal(isLatestSignerApp(""), false);
  assert.equal(isLatestSignerApp(undefined), false);
});

test("getClientSignerApiUrl with no app id returns the stable signer", () => {
  process.env.LATEST_SIGNER_APPS = "app_123";
  process.env.SIGNER_LATEST_URL = "https://latest.example";
  assert.match(getClientSignerApiUrl(), /stable\.example/);
});

test("listed app with a configured latest URL is routed to the latest signer", () => {
  process.env.LATEST_SIGNER_APPS = "app_123,app_234";
  process.env.SIGNER_LATEST_URL = "https://latest.example";
  assert.match(getClientSignerApiUrl("app_123"), /latest\.example/);
  assert.equal(getSignerVersionForApp("app_123"), "latest");
});

test("unlisted app stays on the stable signer even when latest URL is set", () => {
  process.env.LATEST_SIGNER_APPS = "app_123";
  process.env.SIGNER_LATEST_URL = "https://latest.example";
  assert.match(getClientSignerApiUrl("app_999"), /stable\.example/);
  assert.equal(getSignerVersionForApp("app_999"), "stable");
});

test("listed app falls back to stable when no latest URL is configured", () => {
  process.env.LATEST_SIGNER_APPS = "app_123";
  // SIGNER_LATEST_URL intentionally unset.
  assert.match(getClientSignerApiUrl("app_123"), /stable\.example/);
});
