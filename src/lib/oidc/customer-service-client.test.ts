import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db/index";
import { developerApps, oidcClients } from "@/db/schema";
import { test } from "@/test-utils/db-guard";
import { validateClientSecret } from "@/lib/oidc/clients";
import {
  CUSTOMER_SERVICE_OIDC_CLIENT_ID,
  CUSTOMER_SERVICE_OIDC_DISPLAY_NAME,
  CUSTOMER_SERVICE_OIDC_SCOPES,
  ensureCustomerServiceOidcClient,
  desiredCustomerServiceRedirectUrisForEnsure,
  getCustomerServiceOidcClientId,
  getCustomerServiceOrigin,
  hasConfiguredCustomerServiceRedirectOrigin,
  isCustomerServiceOidcClient,
  isOidcReturnPath,
  mergeRedirectUris,
  oidcInteractionPath,
  oidcLoginPathForClient,
  oidcLoginRedirect,
  resolveCustomerServiceRedirectUris,
  resumeAfterOidcLogin,
} from "@/lib/oidc/customer-service-client";

function restoreEnv(t: { after: (fn: () => void) => void }, key: string): void {
  const previous = process.env[key];
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}

function testClientId(): string {
  return `web_cs_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

async function cleanupClient(clientId: string): Promise<void> {
  await db.execute(sql`DELETE FROM oidc_clients WHERE client_id = ${clientId}`);
}

test("getCustomerServiceOidcClientId defaults then honors CS_OIDC_CLIENT_ID", (t) => {
  restoreEnv(t, "CS_OIDC_CLIENT_ID");
  delete process.env.CS_OIDC_CLIENT_ID;
  assert.equal(getCustomerServiceOidcClientId(), CUSTOMER_SERVICE_OIDC_CLIENT_ID);

  process.env.CS_OIDC_CLIENT_ID = " web_already_provisioned ";
  assert.equal(getCustomerServiceOidcClientId(), "web_already_provisioned");
});

test("isCustomerServiceOidcClient matches reserved and env override ids", (t) => {
  restoreEnv(t, "CS_OIDC_CLIENT_ID");
  delete process.env.CS_OIDC_CLIENT_ID;
  assert.equal(isCustomerServiceOidcClient("web_customer_service"), true);
  assert.equal(isCustomerServiceOidcClient("web_other"), false);
  assert.equal(isCustomerServiceOidcClient(null), false);
  assert.equal(oidcLoginPathForClient("web_customer_service"), "/login/admin");
  assert.equal(oidcLoginPathForClient("app_abc"), "/login");
  assert.equal(
    oidcInteractionPath("abc", "web_customer_service"),
    "/oidc/interaction?uid=abc&client_id=web_customer_service",
  );
  assert.equal(oidcInteractionPath("abc"), "/oidc/interaction?uid=abc");
  assert.equal(isOidcReturnPath("/oidc/interaction?uid=abc"), true);
  assert.equal(isOidcReturnPath("/apps"), false);

  const navigated: string[] = [];
  resumeAfterOidcLogin("/apps", (path) => {
    navigated.push(path);
  });
  assert.deepEqual(navigated, ["/apps"]);

  assert.equal(
    oidcLoginRedirect("web_customer_service", "/oidc/interaction?uid=abc"),
    "/login/admin?callbackUrl=%2Foidc%2Finteraction%3Fuid%3Dabc&client_id=web_customer_service",
  );

  process.env.CS_OIDC_CLIENT_ID = "web_already_provisioned";
  assert.equal(isCustomerServiceOidcClient("web_already_provisioned"), true);
  assert.equal(isCustomerServiceOidcClient("web_customer_service"), true);
});

test("resolveCustomerServiceRedirectUris prefers explicit URI list", (t) => {
  restoreEnv(t, "CS_OIDC_REDIRECT_URI");
  restoreEnv(t, "CUSTOMER_SERVICE_URL");
  restoreEnv(t, "NEXT_PUBLIC_CUSTOMER_SERVICE_URL");
  process.env.CS_OIDC_REDIRECT_URI =
    "http://localhost:3010/api/auth/callback/pymthouse,,  https://cs.example.com/api/auth/callback/pymthouse";
  process.env.CUSTOMER_SERVICE_URL = "https://ignored.example";
  assert.deepEqual(resolveCustomerServiceRedirectUris(), [
    "http://localhost:3010/api/auth/callback/pymthouse",
    "https://cs.example.com/api/auth/callback/pymthouse",
  ]);
});

test("resolveCustomerServiceRedirectUris derives callback from NEXTAUTH_URL", (t) => {
  restoreEnv(t, "CS_OIDC_REDIRECT_URI");
  restoreEnv(t, "CUSTOMER_SERVICE_URL");
  restoreEnv(t, "NEXT_PUBLIC_CUSTOMER_SERVICE_URL");
  restoreEnv(t, "NEXTAUTH_URL");
  delete process.env.CS_OIDC_REDIRECT_URI;
  delete process.env.CUSTOMER_SERVICE_URL;
  delete process.env.NEXT_PUBLIC_CUSTOMER_SERVICE_URL;
  process.env.NEXTAUTH_URL = "http://localhost:3010";
  assert.equal(getCustomerServiceOrigin(), "http://localhost:3010");
  assert.deepEqual(resolveCustomerServiceRedirectUris(), [
    "http://localhost:3010/api/auth/callback/pymthouse",
  ]);

  process.env.NEXTAUTH_URL = "https://ops.pymthouse.com";
  assert.equal(getCustomerServiceOrigin(), "https://ops.pymthouse.com");
  assert.deepEqual(resolveCustomerServiceRedirectUris(), [
    "https://ops.pymthouse.com/api/auth/callback/pymthouse",
  ]);

  process.env.NEXT_PUBLIC_CUSTOMER_SERVICE_URL = "https://cs.example.com/";
  assert.deepEqual(resolveCustomerServiceRedirectUris(), [
    "https://cs.example.com/api/auth/callback/pymthouse",
  ]);

  process.env.CUSTOMER_SERVICE_URL = "https://ops.pymthouse.com";
  assert.equal(getCustomerServiceOrigin(), "https://ops.pymthouse.com");
  assert.deepEqual(resolveCustomerServiceRedirectUris(), [
    "https://ops.pymthouse.com/api/auth/callback/pymthouse",
  ]);
});

test("mergeRedirectUris is additive and de-dupes", () => {
  assert.deepEqual(
    mergeRedirectUris(
      ["https://a.example/cb", " https://b.example/cb "],
      ["https://b.example/cb", "https://c.example/cb", ""],
    ),
    ["https://a.example/cb", "https://b.example/cb", "https://c.example/cb"],
  );
});

test("hasConfiguredCustomerServiceRedirectOrigin is false when CS env unset", (t) => {
  restoreEnv(t, "CS_OIDC_REDIRECT_URI");
  restoreEnv(t, "CUSTOMER_SERVICE_URL");
  restoreEnv(t, "NEXT_PUBLIC_CUSTOMER_SERVICE_URL");
  delete process.env.CS_OIDC_REDIRECT_URI;
  delete process.env.CUSTOMER_SERVICE_URL;
  delete process.env.NEXT_PUBLIC_CUSTOMER_SERVICE_URL;
  assert.equal(hasConfiguredCustomerServiceRedirectOrigin(), false);
  assert.deepEqual(desiredCustomerServiceRedirectUrisForEnsure(), []);

  process.env.CUSTOMER_SERVICE_URL = "https://cs.example.com";
  assert.equal(hasConfiguredCustomerServiceRedirectOrigin(), true);
  assert.deepEqual(desiredCustomerServiceRedirectUrisForEnsure(), [
    "https://cs.example.com/api/auth/callback/pymthouse",
  ]);
});

test("ensureCustomerServiceOidcClient does not add localhost when CS env unset on re-run", async (t) => {
  const clientId = testClientId();
  t.after(() => cleanupClient(clientId));
  restoreEnv(t, "CS_OIDC_REDIRECT_URI");
  restoreEnv(t, "CUSTOMER_SERVICE_URL");
  restoreEnv(t, "NEXT_PUBLIC_CUSTOMER_SERVICE_URL");
  delete process.env.CS_OIDC_REDIRECT_URI;
  delete process.env.CUSTOMER_SERVICE_URL;
  delete process.env.NEXT_PUBLIC_CUSTOMER_SERVICE_URL;

  const first = await ensureCustomerServiceOidcClient({
    clientId,
    redirectUris: ["https://cs.example.com/api/auth/callback/pymthouse"],
  });
  const second = await ensureCustomerServiceOidcClient({
    clientId,
    rotateSecret: true,
  });

  assert.equal(second.created, false);
  assert.deepEqual(second.redirectUris, [
    "https://cs.example.com/api/auth/callback/pymthouse",
  ]);
  assert.notEqual(second.clientSecret, first.clientSecret);
});

test("ensureCustomerServiceOidcClient creates a standalone confidential RP", async (t) => {
  const clientId = testClientId();
  t.after(() => cleanupClient(clientId));

  const created = await ensureCustomerServiceOidcClient({
    clientId,
    redirectUris: ["http://localhost:3010/api/auth/callback/pymthouse"],
  });
  assert.equal(created.created, true);
  assert.equal(created.secretRotated, true);
  assert.equal(created.clientId, clientId);
  assert.ok(created.clientSecret?.startsWith("pmth_cs_"));
  assert.equal(
    await validateClientSecret(clientId, created.clientSecret!),
    true,
  );

  const row = await db
    .select()
    .from(oidcClients)
    .where(eq(oidcClients.clientId, clientId))
    .limit(1);
  assert.equal(row[0]?.displayName, CUSTOMER_SERVICE_OIDC_DISPLAY_NAME);
  assert.equal(row[0]?.tokenEndpointAuthMethod, "client_secret_post");
  assert.equal(row[0]?.allowedScopes, CUSTOMER_SERVICE_OIDC_SCOPES);
  assert.ok(row[0]?.grantTypes.includes("authorization_code"));
  assert.ok(row[0]?.grantTypes.includes("refresh_token"));
  assert.ok(CUSTOMER_SERVICE_OIDC_SCOPES.split(" ").includes("admin"));

  const linkedApps = await db
    .select({ id: developerApps.id })
    .from(developerApps)
    .where(eq(developerApps.webOidcClientId, row[0]!.id));
  assert.equal(linkedApps.length, 0);
});

test("ensureCustomerServiceOidcClient is idempotent and merges redirects", async (t) => {
  const clientId = testClientId();
  t.after(() => cleanupClient(clientId));

  const first = await ensureCustomerServiceOidcClient({
    clientId,
    redirectUris: ["http://localhost:3010/api/auth/callback/pymthouse"],
  });
  const second = await ensureCustomerServiceOidcClient({
    clientId,
    redirectUris: ["https://cs.example.com/api/auth/callback/pymthouse"],
  });

  assert.equal(second.created, false);
  assert.equal(second.secretRotated, false);
  assert.equal(second.clientSecret, null);
  assert.deepEqual(second.redirectUris, [
    "http://localhost:3010/api/auth/callback/pymthouse",
    "https://cs.example.com/api/auth/callback/pymthouse",
  ]);
  assert.equal(
    await validateClientSecret(clientId, first.clientSecret!),
    true,
  );
});

test("ensureCustomerServiceOidcClient rotates secret only when asked", async (t) => {
  const clientId = testClientId();
  t.after(() => cleanupClient(clientId));

  const first = await ensureCustomerServiceOidcClient({
    clientId,
    redirectUris: ["http://localhost:3010/api/auth/callback/pymthouse"],
  });
  const rotated = await ensureCustomerServiceOidcClient({
    clientId,
    redirectUris: ["http://localhost:3010/api/auth/callback/pymthouse"],
    rotateSecret: true,
  });

  assert.equal(rotated.created, false);
  assert.equal(rotated.secretRotated, true);
  assert.ok(rotated.clientSecret);
  assert.notEqual(rotated.clientSecret, first.clientSecret);
  assert.equal(
    await validateClientSecret(clientId, first.clientSecret!),
    false,
  );
  assert.equal(
    await validateClientSecret(clientId, rotated.clientSecret!),
    true,
  );
});

test("ensureCustomerServiceOidcClient mints a secret when the hash is missing", async (t) => {
  const clientId = testClientId();
  t.after(() => cleanupClient(clientId));

  await ensureCustomerServiceOidcClient({
    clientId,
    redirectUris: ["http://localhost:3010/api/auth/callback/pymthouse"],
  });
  await db
    .update(oidcClients)
    .set({ clientSecretHash: null })
    .where(eq(oidcClients.clientId, clientId));

  const repaired = await ensureCustomerServiceOidcClient({
    clientId,
    redirectUris: ["http://localhost:3010/api/auth/callback/pymthouse"],
  });
  assert.equal(repaired.created, false);
  assert.equal(repaired.secretRotated, true);
  assert.ok(repaired.clientSecret);
  assert.equal(
    await validateClientSecret(clientId, repaired.clientSecret!),
    true,
  );
});
