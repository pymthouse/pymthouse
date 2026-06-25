import assert from "node:assert/strict";

import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { db } from "@/db/index";
import { endUsers, oidcClients } from "@/db/schema";
import { run } from "@/test-utils/db-guard";
import {
  basicAuthHeader,
  cleanupTestApp,
  seedDeveloperAppWithClient,
} from "@/test-utils/fixtures";
import { resolveDepositAttribution } from "@/lib/turnkey/resolve-deposit-payer";
import {
  __testClearTurnkeyStubs,
  __testSetTurnkeyEvmAddressesStub,
} from "@/lib/turnkey/server-client";

const WALLET = `0x${"c3".repeat(20)}`;

function asNextRequest(init: RequestInit & { url: string }): NextRequest {
  return new Request(init.url, init) as NextRequest;
}

run("wallet API requires users:write scope", async (t) => {
  const { GET, POST } = await import("./route");
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));

  const anonymous = await GET(
    asNextRequest({
      url: `http://localhost/api/v1/apps/${app.clientId}/users/user-1/wallet`,
    }),
    {
      params: Promise.resolve({
        id: app.clientId,
        externalUserId: "user-1",
      }),
    },
  );
  assert.equal(anonymous.status, 401);

  const postMissingJwt = await POST(
    asNextRequest({
      url: `http://localhost/api/v1/apps/${app.clientId}/users/user-1/wallet`,
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(app.clientId, app.clientSecret),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    }),
    {
      params: Promise.resolve({
        id: app.clientId,
        externalUserId: "user-1",
      }),
    },
  );
  assert.equal(postMissingJwt.status, 401);
});

run("GET wallet returns 404 when end user has no binding row", async (t) => {
  const { GET } = await import("./route");
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));

  await db
    .update(oidcClients)
    .set({ allowedScopes: "openid sign:job users:read users:write users:token" })
    .where(eq(oidcClients.clientId, app.clientId));

  const res = await GET(
    asNextRequest({
      url: `http://localhost/api/v1/apps/${app.clientId}/users/no-such-user/wallet`,
      headers: {
        Authorization: basicAuthHeader(app.clientId, app.clientSecret),
      },
    }),
    {
      params: Promise.resolve({
        id: app.clientId,
        externalUserId: "no-such-user",
      }),
    },
  );
  assert.equal(res.status, 404);
});

run("internal deposit resolve requires ingest secret", async (t) => {
  const { GET } = await import(
    "@/app/api/v1/internal/deposits/resolve/route"
  );

  const prev = process.env.INGEST_SHARED_SECRET;
  process.env.INGEST_SHARED_SECRET = "test-ingest-secret";
  t.after(() => {
    if (prev === undefined) delete process.env.INGEST_SHARED_SECRET;
    else process.env.INGEST_SHARED_SECRET = prev;
  });

  const unauthorized = await GET(
    new Request("http://localhost/api/v1/internal/deposits/resolve?from=0x1"),
  );
  assert.equal(unauthorized.status, 401);

  const badAddress = await GET(
    new Request("http://localhost/api/v1/internal/deposits/resolve?from=nope", {
      headers: { Authorization: "Bearer test-ingest-secret" },
    }),
  );
  assert.equal(badAddress.status, 400);
});

run("resolveDepositAttribution maps end_users wallet to clientId", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));

  const orgId = "org-resolve-test";
  __testSetTurnkeyEvmAddressesStub({ [orgId]: [WALLET] }, true);
  t.after(() => __testClearTurnkeyStubs());

  const endUserId = `eu-${Date.now()}`;
  await db.insert(endUsers).values({
    id: endUserId,
    appId: app.clientId,
    externalUserId: "platform-user-1",
    walletAddress: WALLET,
    turnkeySubOrgId: orgId,
    turnkeyUserId: "tk-user-resolve",
  });
  t.after(async () => {
    await db.delete(endUsers).where(eq(endUsers.id, endUserId));
  });

  const attribution = await resolveDepositAttribution(WALLET);
  assert.ok(attribution);
  assert.equal(attribution?.kind, "end_user");
  assert.equal(attribution?.clientId, app.clientId);
  assert.equal(attribution?.externalUserId, "platform-user-1");
  assert.equal(attribution?.endUserId, endUserId);
  assert.equal(attribution?.turnkeyOrgId, orgId);
});
