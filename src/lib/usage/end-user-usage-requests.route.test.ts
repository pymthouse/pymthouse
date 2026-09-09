import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";

import { MAX_DATE_RANGE_DAYS } from "@/lib/billing-utils";
import {
  __testSetEndUserUsageRequestsDeps,
  handleEndUserMeUsageRequestsGet,
} from "@/lib/usage/end-user-usage-handlers";

const AUTH = {
  publicClientId: "app_testclientid000000000001",
  developerAppId: "dev-app-1",
  externalUserId: "eu_subject",
};

function requestsUrl(query = ""): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/apps/${AUTH.publicClientId}/me/usage/requests${query}`,
    { headers: { Authorization: "Bearer test-token" } },
  );
}

function stubEmptyList() {
  return Promise.resolve({
    items: [],
    nextCursor: null,
    openMeterConfigured: true,
  });
}

test.afterEach(() => {
  __testSetEndUserUsageRequestsDeps(null);
});

test("handleEndUserMeUsageRequestsGet returns 400 for a lone from or to", async () => {
  let listCalls = 0;
  __testSetEndUserUsageRequestsDeps({
    authenticateEndUser: async () => AUTH,
    listEndUserSignedTicketRequests: async () => {
      listCalls += 1;
      return stubEmptyList();
    },
  });

  const loneFrom = await handleEndUserMeUsageRequestsGet(
    requestsUrl("?from=2026-09-01T00:00:00.000Z"),
    AUTH.publicClientId,
  );
  assert.equal(loneFrom.status, 400);
  assert.deepEqual(await loneFrom.json(), {
    error: "from and to must be supplied together",
  });

  const loneTo = await handleEndUserMeUsageRequestsGet(
    requestsUrl("?to=2026-09-05T00:00:00.000Z"),
    AUTH.publicClientId,
  );
  assert.equal(loneTo.status, 400);
  assert.deepEqual(await loneTo.json(), {
    error: "from and to must be supplied together",
  });
  assert.equal(listCalls, 0);
});

test("handleEndUserMeUsageRequestsGet returns 400 for an overlong range", async () => {
  __testSetEndUserUsageRequestsDeps({
    authenticateEndUser: async () => AUTH,
  });

  const res = await handleEndUserMeUsageRequestsGet(
    requestsUrl("?from=2025-01-01T00:00:00.000Z&to=2026-09-01T00:00:00.000Z"),
    AUTH.publicClientId,
  );
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), {
    error: `Invalid range; supply from <= to within ${MAX_DATE_RANGE_DAYS} days`,
  });
});

test("handleEndUserMeUsageRequestsGet forwards the parsed window to OpenMeter", async () => {
  const seen: unknown[] = [];
  __testSetEndUserUsageRequestsDeps({
    authenticateEndUser: async () => AUTH,
    listEndUserSignedTicketRequests: async (input) => {
      seen.push(input);
      return stubEmptyList();
    },
  });

  const from = "2026-09-01T00:00:00.000Z";
  const to = "2026-09-05T23:59:59.999Z";
  const res = await handleEndUserMeUsageRequestsGet(
    requestsUrl(`?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    AUTH.publicClientId,
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { groupBy: string; clientId: string };
  assert.equal(body.groupBy, "request");
  assert.equal(body.clientId, AUTH.publicClientId);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], {
    externalUserId: AUTH.externalUserId,
    clientId: AUTH.publicClientId,
    manifestId: undefined,
    cursor: undefined,
    limit: undefined,
    from,
    to,
  });
});

test("handleEndUserMeUsageRequestsGet forwards from/to for groupBy=session", async () => {
  const seen: unknown[] = [];
  __testSetEndUserUsageRequestsDeps({
    authenticateEndUser: async () => AUTH,
    listEndUserSignedTicketSessions: async (input) => {
      seen.push(input);
      return stubEmptyList();
    },
  });

  const from = "2026-08-01T00:00:00.000Z";
  const to = "2026-08-31T23:59:59.999Z";
  const res = await handleEndUserMeUsageRequestsGet(
    requestsUrl(
      `?groupBy=session&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    ),
    AUTH.publicClientId,
  );
  assert.equal(res.status, 200);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], {
    externalUserId: AUTH.externalUserId,
    clientId: AUTH.publicClientId,
    cursor: undefined,
    limit: undefined,
    from,
    to,
  });
});

test("handleEndUserMeUsageRequestsGet omits from/to when the pair is absent", async () => {
  const seen: unknown[] = [];
  __testSetEndUserUsageRequestsDeps({
    authenticateEndUser: async () => AUTH,
    listEndUserSignedTicketRequests: async (input) => {
      seen.push(input);
      return stubEmptyList();
    },
  });

  const res = await handleEndUserMeUsageRequestsGet(
    requestsUrl(),
    AUTH.publicClientId,
  );
  assert.equal(res.status, 200);
  assert.equal(seen.length, 1);
  const input = seen[0] as { from?: string; to?: string };
  assert.equal(input.from, undefined);
  assert.equal(input.to, undefined);
});
