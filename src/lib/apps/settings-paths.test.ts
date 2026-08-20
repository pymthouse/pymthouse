import assert from "node:assert/strict";
import test from "node:test";
import {
  appSettingsAbsoluteUrl,
  appSettingsPath,
  appSettingsTabFromPathname,
  normalizeAppSettingsTab,
} from "./settings-paths";

test("appSettingsPath: profile is bare app path", () => {
  assert.equal(appSettingsPath("app_1"), "/apps/app_1");
  assert.equal(appSettingsPath("app_1", "profile"), "/apps/app_1");
});

test("appSettingsPath: other tabs are path segments", () => {
  assert.equal(appSettingsPath("app_1", "payments"), "/apps/app_1/payments");
  assert.equal(appSettingsPath("app_1", "credentials"), "/apps/app_1/credentials");
  assert.equal(appSettingsPath("app_1", "plans"), "/apps/app_1/plans");
});

test("normalizeAppSettingsTab aliases", () => {
  assert.equal(normalizeAppSettingsTab("billing"), "payments");
  assert.equal(normalizeAppSettingsTab("auth"), "profile");
  assert.equal(normalizeAppSettingsTab("network-discovery"), "plans");
  assert.equal(normalizeAppSettingsTab("unknown"), "profile");
});

test("appSettingsAbsoluteUrl keeps callback query on path", () => {
  assert.equal(
    appSettingsAbsoluteUrl("https://builder.example", "app_1", "payments", {
      connected: "1",
    }),
    "https://builder.example/apps/app_1/payments?connected=1",
  );
  assert.equal(
    appSettingsAbsoluteUrl("https://builder.example/", "app_1", "payments", {
      connect: "refresh",
    }),
    "https://builder.example/apps/app_1/payments?connect=refresh",
  );
});

test("appSettingsTabFromPathname", () => {
  assert.equal(appSettingsTabFromPathname("/apps/app_1"), "profile");
  assert.equal(appSettingsTabFromPathname("/apps/app_1/payments"), "payments");
  assert.equal(appSettingsTabFromPathname("/apps/app_1/settings"), "profile");
  assert.equal(appSettingsTabFromPathname("/apps/app_1/auth"), "profile");
  assert.equal(
    appSettingsTabFromPathname("/apps/app_1/discovery-profiles"),
    "plans",
  );
  assert.equal(appSettingsTabFromPathname("/apps/app_1/identities"), null);
  assert.equal(appSettingsTabFromPathname("/apps/app_1/usage"), null);
});
