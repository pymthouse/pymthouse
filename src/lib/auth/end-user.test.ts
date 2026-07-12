import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

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
} from "@/lib/auth/end-user";
import { hashToken } from "@/lib/token-hash";


import { endUserSubjectOverrideError } from "@/lib/auth/end-user";

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
  const bare = `pmth_${"c".repeat(64)}`;
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

run("authenticateEndUser resolves composite Bearer to end-user identity", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));

  const externalUserId = `user-${randomUUID()}`;
  const appUser = await createAppUser({
    clientId: app.clientId,
    externalUserId,
  });
  const bare = `pmth_${"d".repeat(64)}`;
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
    new Request("http://localhost/api/v1/user/usage", {
      headers: { Authorization: `Bearer ${composite}` },
    }),
  );
  assert.ok(auth);
  assert.equal(auth?.externalUserId, externalUserId);
  assert.equal(auth?.publicClientId, app.clientId);
  assert.equal(auth?.developerAppId, app.clientId);
});

test("authenticateEndUser returns null without Authorization", async () => {
  const auth = await authenticateEndUser(new Request("http://localhost/api/v1/user/usage"));
  assert.equal(auth, null);
});
