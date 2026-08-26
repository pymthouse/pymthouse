import assert from "node:assert/strict";
import test from "node:test";

import { eq } from "drizzle-orm";

import { db } from "@/db/index";
import { developerApps, oidcClients } from "@/db/schema";
import { test as dbTest } from "@/test-utils/db-guard";
import { cleanupTestApp, seedDeveloperAppWithClient } from "@/test-utils/fixtures";

import {
  getDefaultBranding,
  resolveAppBrandingByClientId,
  resolveAppBrandingFromRows,
} from "./branding";
import { createAppClient, getClient, updateClientConfig } from "./clients";

type DeveloperAppRow = typeof developerApps.$inferSelect;

function stubApp(overrides: Partial<DeveloperAppRow> = {}): DeveloperAppRow {
  return {
    id: "app_test",
    name: "Test App",
    brandingMode: "blackLabel",
    websiteUrl: "https://acme.example",
    privacyPolicyUrl: null,
    tosUrl: null,
    supportUrl: null,
    developerName: "Acme",
    brandingLogoUrl: null,
    logoLightUrl: null,
    brandingPrimaryColor: null,
    brandingSupportEmail: null,
    customLoginEnabled: 0,
    customLoginDomain: null,
    ...overrides,
  } as DeveloperAppRow;
}

test("resolveAppBrandingFromRows returns defaults when the client is missing", () => {
  const branding = resolveAppBrandingFromRows(undefined, undefined);
  assert.deepEqual(branding, getDefaultBranding());
});

test("resolveAppBrandingFromRows uses client name and logo when no app row exists", () => {
  const branding = resolveAppBrandingFromRows(
    { displayName: "Portal", logoUri: "https://cdn.example/logo.png" },
    undefined,
  );
  assert.equal(branding.mode, "blackLabel");
  assert.equal(branding.displayName, "Portal");
  assert.equal(branding.logoUrl, "https://cdn.example/logo.png");
});

test("resolveAppBrandingFromRows treats an empty client logo as null", () => {
  const branding = resolveAppBrandingFromRows(
    { displayName: "Portal", logoUri: "" },
    undefined,
  );
  assert.equal(branding.logoUrl, null);
});

test("resolveAppBrandingFromRows uses black-label app branding when an app row exists", () => {
  const branding = resolveAppBrandingFromRows(
    { displayName: "Ignored Client", logoUri: "https://cdn.example/ignored.png" },
    stubApp(),
  );
  assert.equal(branding.mode, "blackLabel");
  assert.equal(branding.appId, "app_test");
  assert.equal(branding.appName, "Test App");
  assert.equal(branding.displayName, "pymthouse");
  assert.equal(branding.logoUrl, null);
  assert.equal(branding.developerName, "Acme");
});

test("resolveAppBrandingFromRows uses white-label app branding", () => {
  const branding = resolveAppBrandingFromRows(
    { displayName: "Ignored Client", logoUri: null },
    stubApp({
      brandingMode: "whiteLabel",
      brandingLogoUrl: "https://cdn.example/brand.png",
      brandingPrimaryColor: "#112233",
      brandingSupportEmail: "help@acme.example",
      customLoginEnabled: 1,
      customLoginDomain: "login.acme.example",
    }),
  );
  assert.equal(branding.mode, "whiteLabel");
  assert.equal(branding.displayName, "Test App");
  assert.equal(branding.logoUrl, "https://cdn.example/brand.png");
  assert.equal(branding.primaryColor, "#112233");
  assert.equal(branding.supportEmail, "help@acme.example");
  assert.equal(branding.customLoginDomain, "login.acme.example");
  assert.equal(branding.customLoginEnabled, true);
});

test("resolveAppBrandingFromRows falls back to logoLightUrl for white-label apps", () => {
  const branding = resolveAppBrandingFromRows(
    { displayName: "Portal", logoUri: null },
    stubApp({
      brandingMode: "whiteLabel",
      logoLightUrl: "https://cdn.example/light.png",
    }),
  );
  assert.equal(branding.logoUrl, "https://cdn.example/light.png");
});

dbTest("resolveAppBrandingByClientId returns defaults for an unknown client", async () => {
  const branding = await resolveAppBrandingByClientId("app_does_not_exist");
  assert.deepEqual(branding, getDefaultBranding());
});

dbTest("resolveAppBrandingByClientId uses client metadata when no app is linked", async (t) => {
  const orphan = await createAppClient("Orphan Portal");
  t.after(async () => {
    await db.delete(oidcClients).where(eq(oidcClients.id, orphan.id));
  });

  await updateClientConfig(orphan.clientId, {
    logoUri: "https://cdn.example/orphan.png",
  });

  const branding = await resolveAppBrandingByClientId(orphan.clientId);
  assert.equal(branding.displayName, "Orphan Portal");
  assert.equal(branding.logoUrl, "https://cdn.example/orphan.png");
});

dbTest("resolveAppBrandingByClientId and getClient expose linked app branding", async (t) => {
  const app = await seedDeveloperAppWithClient({ name: "Consent App" });
  t.after(async () => {
    await cleanupTestApp(app);
  });

  await updateClientConfig(app.clientId, {
    logoUri: "https://cdn.example/client-logo.png",
  });
  const client = await getClient(app.clientId);
  assert.equal(client?.logoUri, "https://cdn.example/client-logo.png");

  const blackLabel = await resolveAppBrandingByClientId(app.clientId);
  assert.equal(blackLabel.mode, "blackLabel");
  assert.equal(blackLabel.appId, app.clientId);
  assert.equal(blackLabel.displayName, "pymthouse");

  await db
    .update(developerApps)
    .set({
      brandingMode: "whiteLabel",
      brandingLogoUrl: "https://cdn.example/white.png",
    })
    .where(eq(developerApps.id, app.clientId));

  const whiteLabel = await resolveAppBrandingByClientId(app.clientId);
  assert.equal(whiteLabel.mode, "whiteLabel");
  assert.equal(whiteLabel.displayName, "Consent App");
  assert.equal(whiteLabel.logoUrl, "https://cdn.example/white.png");
});
