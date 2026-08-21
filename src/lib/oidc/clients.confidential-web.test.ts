import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { db } from "@/db/index";
import { developerApps, oidcClients } from "@/db/schema";
import { test } from "@/test-utils/db-guard";
import { cleanupTestApp, seedDeveloperAppWithClient } from "@/test-utils/fixtures";
import {
  ensureConfidentialWebClient,
  generateWebClientId,
  loadConfidentialWebOidcClientSummary,
  removeConfidentialWebClient,
} from "./clients";

test("generateWebClientId uses web_ prefix", () => {
  const id = generateWebClientId();
  assert.match(id, /^web_[0-9a-f]{24}$/);
});

test("ensureConfidentialWebClient creates, updates, loads, and removes sibling", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(async () => {
    await removeConfidentialWebClient(app.clientId).catch(() => undefined);
    await cleanupTestApp(app);
  });

  assert.equal(await loadConfidentialWebOidcClientSummary(app.clientId), null);
  assert.equal(await removeConfidentialWebClient(app.clientId), false);

  const created = await ensureConfidentialWebClient({
    appInternalId: app.clientId,
    appDisplayName: "Portal SSO App",
    redirectUris: ["https://portal.example.com/login"],
  });
  assert.ok(created);
  assert.match(created.clientId, /^web_/);

  const appAfter = await db
    .select({
      webOidcClientId: developerApps.webOidcClientId,
      oidcClientId: developerApps.oidcClientId,
    })
    .from(developerApps)
    .where(eq(developerApps.id, app.clientId))
    .limit(1);
  assert.equal(appAfter[0]?.webOidcClientId, created.id);

  const webRow = await db
    .select()
    .from(oidcClients)
    .where(eq(oidcClients.id, created.id))
    .limit(1);
  assert.equal(webRow[0]?.tokenEndpointAuthMethod, "client_secret_post");
  assert.ok(webRow[0]?.grantTypes.includes("authorization_code"));
  assert.deepEqual(JSON.parse(webRow[0]?.redirectUris ?? "[]"), [
    "https://portal.example.com/login",
  ]);

  // Public app_ row is demoted when a confidential sibling exists.
  const pub = await db
    .select()
    .from(oidcClients)
    .where(eq(oidcClients.id, app.oidcClientRowId))
    .limit(1);
  assert.equal(pub[0]?.tokenEndpointAuthMethod, "none");
  assert.equal(pub[0]?.clientSecretHash, null);

  const summary = await loadConfidentialWebOidcClientSummary(app.clientId);
  assert.ok(summary);
  assert.equal(summary.clientId, created.clientId);
  assert.equal(summary.hasSecret, false);
  assert.deepEqual(summary.redirectUris, ["https://portal.example.com/login"]);

  const again = await ensureConfidentialWebClient({
    appInternalId: app.clientId,
    appDisplayName: "Portal SSO App",
    redirectUris: [" https://portal.example.com/callback ", ""],
  });
  assert.ok(again);
  assert.equal(again.clientId, created.clientId);

  const updated = await loadConfidentialWebOidcClientSummary(app.clientId);
  assert.deepEqual(updated?.redirectUris, [
    "https://portal.example.com/callback",
  ]);

  const idempotent = await ensureConfidentialWebClient({
    appInternalId: app.clientId,
    appDisplayName: "Portal SSO App",
  });
  assert.equal(idempotent?.clientId, created.clientId);

  assert.equal(await removeConfidentialWebClient(app.clientId), true);
  assert.equal(await loadConfidentialWebOidcClientSummary(app.clientId), null);

  const gone = await db
    .select()
    .from(oidcClients)
    .where(eq(oidcClients.id, created.id))
    .limit(1);
  assert.equal(gone.length, 0);
});

test("ensureConfidentialWebClient returns null without a public OIDC row", async () => {
  const result = await ensureConfidentialWebClient({
    appInternalId: "app_missing_for_web_sibling_test",
    appDisplayName: "Nope",
  });
  assert.equal(result, null);
});
