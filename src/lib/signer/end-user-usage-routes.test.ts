import assert from "node:assert/strict";
import test from "node:test";

import { routeEndUserUsageRequest } from "@pymthouse/builder-sdk/usage";
import type { EndUserAuthVerifier } from "@pymthouse/builder-sdk/signer/webhook";
import { buildEndUserUsageRequestConfig } from "@/lib/signer/end-user-usage-handlers";

const CLIENT_ID = "app_x";
const EXTERNAL_USER_ID = "user-42";

const mockEndUserAuth: EndUserAuthVerifier = {
  kind: "custom",
  verify: async () => ({
    identity: {
      issuer: "https://auth.test",
      client_id: CLIENT_ID,
      usage_subject: EXTERNAL_USER_ID,
      usage_subject_type: "external_user_id",
    },
    expiry: 4_102_444_800,
    raw: { scope: "sign:job" },
  }),
};

function buildTestConfig() {
  return {
    ...buildEndUserUsageRequestConfig(),
    endUserAuth: mockEndUserAuth,
    readBalance: async () => ({
      externalUserId: EXTERNAL_USER_ID,
      balanceUsdMicros: "5000000",
      consumedUsdMicros: "1000000",
      lifetimeGrantedUsdMicros: "6000000",
      hasAccess: true,
      remainingUsdMicros: "5000000",
    }),
  };
}

test("routeEndUserUsageRequest returns balance with mocked readBalance", async () => {
  const request = new Request(
    `http://localhost/api/v1/apps/${CLIENT_ID}/usage/me/balance`,
    {
      method: "GET",
      headers: { Authorization: "Bearer good-token" },
    },
  );

  const response = await routeEndUserUsageRequest(request, buildTestConfig());
  assert.ok(response);
  assert.equal(response.status, 200);

  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.clientId, CLIENT_ID);
  assert.equal(body.externalUserId, EXTERNAL_USER_ID);
  assert.equal(body.balanceUsdMicros, "5000000");
});

test("routeEndUserUsageRequest rejects externalUserId query param", async () => {
  const request = new Request(
    `http://localhost/api/v1/apps/${CLIENT_ID}/usage/me/balance?externalUserId=other-user`,
    {
      method: "GET",
      headers: { Authorization: "Bearer good-token" },
    },
  );

  const response = await routeEndUserUsageRequest(request, buildTestConfig());
  assert.ok(response);
  assert.equal(response.status, 400);
});

test("routeEndUserUsageRequest rejects userId query param", async () => {
  const request = new Request(
    `http://localhost/api/v1/apps/${CLIENT_ID}/usage/me/balance?userId=other-user`,
    {
      method: "GET",
      headers: { Authorization: "Bearer good-token" },
    },
  );

  const response = await routeEndUserUsageRequest(request, buildTestConfig());
  assert.ok(response);
  assert.equal(response.status, 400);
});

test("routeEndUserUsageRequest returns 404 for client id mismatch", async () => {
  const request = new Request(
    "http://localhost/api/v1/apps/other-app/usage/me/balance",
    {
      method: "GET",
      headers: { Authorization: "Bearer good-token" },
    },
  );

  const response = await routeEndUserUsageRequest(request, buildTestConfig());
  assert.ok(response);
  assert.equal(response.status, 404);
});
