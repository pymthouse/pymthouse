import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { db } from "@/db/index";
import { developerApps, oidcClients } from "@/db/schema";
import { test } from "@/test-utils/db-guard";
import { cleanupTestApp, createTestUserWithCleanup, seedDeveloperAppWithClient } from "@/test-utils/fixtures";
import { checkAppAccess } from "./app-access";
import {
  ensureConfidentialWebClient,
  ensureM2mBackendClient,
  removeConfidentialWebClient,
  removeM2mBackendClient,
} from "./clients";
import { ensureCustomerServiceOidcClient } from "./customer-service-client";

test("checkAppAccess allows public, m2m, and web sibling client ids", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(async () => {
    await removeConfidentialWebClient(app.clientId).catch(() => undefined);
    await removeM2mBackendClient(app.clientId).catch(() => undefined);
    await cleanupTestApp(app);
  });

  const publicOk = await checkAppAccess(app.clientId, null);
  assert.equal(publicOk.allowed, true);
  assert.equal(publicOk.appName, (
    await db.select({ name: developerApps.name }).from(developerApps).where(eq(developerApps.id, app.clientId)).limit(1)
  )[0]?.name);

  const m2m = await ensureM2mBackendClient({
    appInternalId: app.clientId,
    appDisplayName: "Access Check App",
  });
  assert.ok(m2m);
  const m2mOk = await checkAppAccess(m2m.clientId, null);
  assert.equal(m2mOk.allowed, true);

  const web = await ensureConfidentialWebClient({
    appInternalId: app.clientId,
    appDisplayName: "Access Check App",
    redirectUris: ["https://portal.example.com/login"],
  });
  assert.ok(web);
  const webOk = await checkAppAccess(web.clientId, null);
  assert.equal(webOk.allowed, true);

  const unknown = await checkAppAccess("web_does_not_exist", null);
  assert.equal(unknown.allowed, false);
  assert.equal(unknown.reason, "Client not found");
});

test("checkAppAccess allows open DCR client ids", async () => {
  const result = await checkAppAccess("dcr_abcdef0123456789", null);
  assert.equal(result.allowed, true);
  assert.equal(result.dynamicClient, true);
});

test("checkAppAccess rejects oidc row with no developer app link", async (t) => {
  const orphanId = `web_orphan_${Date.now().toString(16)}`;
  await db.insert(oidcClients).values({
    id: crypto.randomUUID(),
    clientId: orphanId,
    clientSecretHash: null,
    displayName: "Orphan",
    redirectUris: JSON.stringify(["https://example.com/cb"]),
    allowedScopes: "openid",
    grantTypes: "authorization_code,refresh_token",
    tokenEndpointAuthMethod: "client_secret_post",
  });
  t.after(async () => {
    await db.delete(oidcClients).where(eq(oidcClients.clientId, orphanId));
  });

  const result = await checkAppAccess(orphanId, null);
  assert.equal(result.allowed, false);
  assert.equal(
    result.reason,
    "Client is not associated with a registered developer app",
  );
});

test("checkAppAccess allows the reserved customer-service RP without a developer app", async (t) => {
  const clientId = `web_cs_${Date.now().toString(16)}`;
  t.after(async () => {
    await db.delete(oidcClients).where(eq(oidcClients.clientId, clientId));
  });
  const previous = process.env.CS_OIDC_CLIENT_ID;
  process.env.CS_OIDC_CLIENT_ID = clientId;
  t.after(() => {
    if (previous === undefined) delete process.env.CS_OIDC_CLIENT_ID;
    else process.env.CS_OIDC_CLIENT_ID = previous;
  });

  await ensureCustomerServiceOidcClient({
    clientId,
    redirectUris: ["http://localhost:3010/api/auth/callback/pymthouse"],
  });
  const result = await checkAppAccess(clientId, null);
  assert.equal(result.allowed, true);
  assert.equal(result.appName, "Customer Service");

  const developer = await createTestUserWithCleanup(t, { role: "developer" });
  const denied = await checkAppAccess(clientId, developer);
  assert.equal(denied.allowed, false);
  assert.match(denied.reason ?? "", /platform admin/);

  const admin = await createTestUserWithCleanup(t, { role: "admin" });
  const allowed = await checkAppAccess(clientId, admin);
  assert.equal(allowed.allowed, true);
});
