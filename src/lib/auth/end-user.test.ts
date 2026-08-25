import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";

import { run } from "@/test-utils/db-guard";
import {
  cleanupTestApp,
  createAppUser,
  seedDeveloperAppWithClient,
} from "@/test-utils/fixtures";
import { db } from "@/db/index";
import { apiKeys } from "@/db/schema";
import {
  formatCompositeApiKey,
  resolveActiveAppApiKeyFromBearer,
} from "@/lib/app-api-keys";
import {
  authenticateEndUser,
  endUserSubjectOverrideError,
  requireEndUserRouteAuth,
} from "@/lib/auth/end-user";
import { getIssuer } from "@/lib/oidc/issuer-urls";
import { ACCESS_TOKEN_JWT_TYP, ensureSigningKey } from "@/lib/oidc/jwks";
import { hashToken } from "@/lib/token-hash";

const OTHER_CLIENT_ID = "app_otherclientid0000000001";

async function mintEndUserJwt(input: {
  publicClientId: string;
  sub: string;
  claims?: Record<string, unknown>;
}): Promise<string> {
  const issuer = getIssuer();
  const keyPair = await ensureSigningKey();
  const nowSeconds = Math.floor(Date.now() / 1000);
  return new SignJWT({
    client_id: input.publicClientId,
    ...input.claims,
  })
    .setProtectedHeader({
      alg: "RS256",
      kid: keyPair.kid,
      typ: ACCESS_TOKEN_JWT_TYP,
    })
    .setIssuer(issuer)
    .setAudience(issuer)
    .setSubject(input.sub)
    .setJti(uuidv4())
    .setIssuedAt(nowSeconds)
    .setNotBefore(nowSeconds)
    .setExpirationTime(nowSeconds + 300)
    .sign(keyPair.privateKey);
}

test("endUserSubjectOverrideError rejects userId and externalUserId", () => {
  for (const key of ["userId", "externalUserId", "external_user_id"]) {
    const params = new URLSearchParams({ [key]: "someone-else" });
    const res = endUserSubjectOverrideError(params, "usage");
    assert.ok(res);
    assert.equal(res.status, 400);
  }
  assert.equal(endUserSubjectOverrideError(new URLSearchParams(), "usage"), null);
});

run("resolveActiveAppApiKeyFromBearer accepts composite and bare keys", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));

  const externalUserId = `user-${randomUUID()}`;
  const appUser = await createAppUser({
    clientId: app.clientId,
    externalUserId,
  });
  const bare = `pmth_${randomUUID().replaceAll("-", "")}${"1".repeat(32)}`;
  await db.insert(apiKeys).values({
    id: `key-${randomUUID()}`,
    keyHash: hashToken(bare),
    clientId: app.clientId,
    appUserId: appUser.id,
    label: "end-user key",
    status: "active",
  });

  const composite = formatCompositeApiKey(app.clientId, bare);
  const fromComposite = await resolveActiveAppApiKeyFromBearer(composite);
  assert.ok(fromComposite);
  assert.equal(fromComposite?.externalUserId, externalUserId);
  assert.equal(fromComposite?.publicClientId, app.clientId);

  const fromBare = await resolveActiveAppApiKeyFromBearer(bare);
  assert.ok(fromBare);
  assert.equal(fromBare?.externalUserId, externalUserId);
});

run("authenticateEndUser resolves bare Bearer to end-user identity", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));

  const externalUserId = `user-${randomUUID()}`;
  const appUser = await createAppUser({
    clientId: app.clientId,
    externalUserId,
  });
  const bare = `pmth_${randomUUID().replaceAll("-", "")}${"2".repeat(32)}`;
  await db.insert(apiKeys).values({
    id: `key-${randomUUID()}`,
    keyHash: hashToken(bare),
    clientId: app.clientId,
    appUserId: appUser.id,
    label: "end-user key",
    status: "active",
  });

  const auth = await authenticateEndUser(
    new Request(`http://localhost/api/v1/apps/${app.clientId}/me/usage`, {
      headers: { Authorization: `Bearer ${bare}` },
    }),
  );
  assert.ok(auth);
  assert.equal(auth?.externalUserId, externalUserId);
  assert.equal(auth?.publicClientId, app.clientId);
  assert.equal(auth?.developerAppId, app.clientId);

  const mismatched = await authenticateEndUser(
    new Request(`http://localhost/api/v1/apps/${OTHER_CLIENT_ID}/me/usage`, {
      headers: { Authorization: `Bearer ${bare}` },
    }),
    { expectedPublicClientId: OTHER_CLIENT_ID },
  );
  assert.equal(mismatched, null);

  const matched = await authenticateEndUser(
    new Request(`http://localhost/api/v1/apps/${app.clientId}/me/usage`, {
      headers: { Authorization: `Bearer ${bare}` },
    }),
    { expectedPublicClientId: app.clientId },
  );
  assert.ok(matched);
  assert.equal(matched?.publicClientId, app.clientId);
});

run("authenticateEndUser resolves composite Bearer to end-user identity", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));

  const externalUserId = `user-${randomUUID()}`;
  const appUser = await createAppUser({
    clientId: app.clientId,
    externalUserId,
  });
  const bare = `pmth_${randomUUID().replaceAll("-", "")}${"3".repeat(32)}`;
  await db.insert(apiKeys).values({
    id: `key-${randomUUID()}`,
    keyHash: hashToken(bare),
    clientId: app.clientId,
    appUserId: appUser.id,
    label: "end-user key",
    status: "active",
  });

  const composite = formatCompositeApiKey(app.clientId, bare);
  const auth = await authenticateEndUser(
    new Request(`http://localhost/api/v1/apps/${app.clientId}/me/usage`, {
      headers: { Authorization: `Bearer ${composite}` },
    }),
    { expectedPublicClientId: app.clientId },
  );
  assert.ok(auth);
  assert.equal(auth?.externalUserId, externalUserId);
  assert.equal(auth?.publicClientId, app.clientId);
  assert.equal(auth?.developerAppId, app.clientId);
});

test("authenticateEndUser returns null without Authorization", async () => {
  const auth = await authenticateEndUser(
    new Request("http://localhost/api/v1/apps/app_x/me/usage"),
  );
  assert.equal(auth, null);
});

run("authenticateEndUser rejects mismatched expectedPublicClientId for signer JWT", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));

  const externalUserId = `user-${randomUUID()}`;
  await createAppUser({
    clientId: app.clientId,
    externalUserId,
  });

  const token = await mintEndUserJwt({
    publicClientId: app.clientId,
    sub: externalUserId,
    claims: {
      external_user_id: externalUserId,
      user_type: "external_user",
      scope: "sign:job",
    },
  });

  const matched = await authenticateEndUser(
    new Request(`http://localhost/api/v1/apps/${app.clientId}/me/usage`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    { expectedPublicClientId: app.clientId },
  );
  assert.ok(matched);
  assert.equal(matched?.externalUserId, externalUserId);
  assert.equal(matched?.publicClientId, app.clientId);

  const mismatched = await authenticateEndUser(
    new Request(`http://localhost/api/v1/apps/${OTHER_CLIENT_ID}/me/usage`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    { expectedPublicClientId: OTHER_CLIENT_ID },
  );
  assert.equal(mismatched, null);
});

run("authenticateEndUser rejects mismatched expectedPublicClientId for subject access token", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));

  const externalUserId = `user-${randomUUID()}`;
  const appUser = await createAppUser({
    clientId: app.clientId,
    externalUserId,
  });

  const token = await mintEndUserJwt({
    publicClientId: app.clientId,
    sub: appUser.id,
    claims: {
      user_type: "app_user",
      scope: "openid",
    },
  });

  const matched = await authenticateEndUser(
    new Request(`http://localhost/api/v1/apps/${app.clientId}/me/usage`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    { expectedPublicClientId: app.clientId },
  );
  assert.ok(matched);
  assert.equal(matched?.externalUserId, externalUserId);
  assert.equal(matched?.publicClientId, app.clientId);

  const mismatched = await authenticateEndUser(
    new Request(`http://localhost/api/v1/apps/${OTHER_CLIENT_ID}/me/usage`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    { expectedPublicClientId: OTHER_CLIENT_ID },
  );
  assert.equal(mismatched, null);
});

test("requireEndUserRouteAuth returns 401 without a credential", async () => {
  const result = await requireEndUserRouteAuth(
    new NextRequest("http://localhost/api/v1/apps/app_x/me/billing/allowances"),
    "app_x",
    "allowances",
  );
  assert.ok("response" in result);
  assert.equal(result.response.status, 401);
});

test("requireEndUserRouteAuth returns 400 on subject override", async () => {
  const result = await requireEndUserRouteAuth(
    new NextRequest(
      "http://localhost/api/v1/apps/app_x/me/billing/allowances?externalUserId=other",
    ),
    "app_x",
    "allowances",
  );
  assert.ok("response" in result);
  assert.equal(result.response.status, 400);
});

run("requireEndUserRouteAuth accepts matching Bearer", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));

  const externalUserId = `user-${randomUUID()}`;
  const appUser = await createAppUser({
    clientId: app.clientId,
    externalUserId,
  });
  const bare = `pmth_${randomUUID().replaceAll("-", "")}${"9".repeat(32)}`;
  await db.insert(apiKeys).values({
    id: `key-${randomUUID()}`,
    keyHash: hashToken(bare),
    clientId: app.clientId,
    appUserId: appUser.id,
    label: "end-user key",
    status: "active",
  });

  const result = await requireEndUserRouteAuth(
    new NextRequest(
      `http://localhost/api/v1/apps/${app.clientId}/me/billing/allowances`,
      { headers: { Authorization: `Bearer ${bare}` } },
    ),
    app.clientId,
    "allowances",
  );
  assert.ok("auth" in result);
  assert.equal(result.auth.externalUserId, externalUserId);
  assert.equal(result.auth.publicClientId, app.clientId);
});
