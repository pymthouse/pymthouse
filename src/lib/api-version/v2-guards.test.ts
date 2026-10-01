import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest, NextResponse } from "next/server";

import {
  END_USER_CREDENTIAL_REQUIRED_CODE,
  withoutSubjectOverride,
} from "@/lib/api-version/v2-guards";
import { EXTERNAL_USER_ID_REQUIRED_CODE } from "@/lib/billing/wallet-billing-target";

const CLIENT_ID = "app_testdummyclientid000002";
const ctx = { params: Promise.resolve({ id: CLIENT_ID }) };

function guarded(response: () => Response) {
  let calls = 0;
  const handler = withoutSubjectOverride(async () => {
    calls += 1;
    return response();
  }, "/wallet");
  return { handler, calls: () => calls };
}

async function assertEndUserCredentialRequired(response: Response) {
  assert.equal(response.status, 403);
  const body = (await response.json()) as { code?: string };
  assert.equal(body.code, END_USER_CREDENTIAL_REQUIRED_CODE);
  assert.equal(
    response.headers.get("link"),
    `</api/v2/apps/${CLIENT_ID}/me/billing/wallet>; rel="successor-version"`,
  );
}

test("withoutSubjectOverride rejects a query subject before calling the handler", async () => {
  for (const key of ["externalUserId", "external_user_id", "userId"]) {
    const { handler, calls } = guarded(() => NextResponse.json({ ok: true }));
    const response = await handler(
      new NextRequest(
        `http://localhost/api/v2/apps/${CLIENT_ID}/billing/wallet?${key}=`,
      ),
      ctx,
    );
    await assertEndUserCredentialRequired(response);
    assert.equal(calls(), 0, key);
  }
});

test("withoutSubjectOverride rejects a JSON body subject and leaves the body readable", async () => {
  const { handler, calls } = guarded(() => NextResponse.json({ ok: true }));
  const rejected = await handler(
    new NextRequest(`http://localhost/api/v2/apps/${CLIENT_ID}/billing/wallet`, {
      method: "PATCH",
      body: JSON.stringify({ externalUserId: "user-1", enabled: true }),
      headers: { "Content-Type": "application/json" },
    }),
    ctx,
  );
  await assertEndUserCredentialRequired(rejected);
  assert.equal(calls(), 0);

  let seenBody: unknown = null;
  const passthrough = withoutSubjectOverride(async (request: NextRequest) => {
    seenBody = await request.json();
    return NextResponse.json({ ok: true });
  }, "/wallet");
  const ok = await passthrough(
    new NextRequest(`http://localhost/api/v2/apps/${CLIENT_ID}/billing/wallet`, {
      method: "PATCH",
      body: JSON.stringify({ externalUserId: "  ", enabled: true }),
      headers: { "Content-Type": "application/json" },
    }),
    ctx,
  );
  assert.equal(ok.status, 200);
  assert.deepEqual(seenBody, { externalUserId: "  ", enabled: true });
});

test("withoutSubjectOverride maps merchant external_user_id_required to the /me successor", async () => {
  const { handler } = guarded(() =>
    NextResponse.json(
      { error: "externalUserId is required", code: EXTERNAL_USER_ID_REQUIRED_CODE },
      { status: 400 },
    ),
  );
  await assertEndUserCredentialRequired(
    await handler(
      new NextRequest(`http://localhost/api/v2/apps/${CLIENT_ID}/billing/wallet`),
      ctx,
    ),
  );
});

test("withoutSubjectOverride passes other responses through unchanged", async () => {
  for (const [status, body] of [
    [200, { balance: null }],
    [404, { error: "Not found" }],
    [400, { error: "bad amount" }],
  ] as const) {
    const { handler } = guarded(() => NextResponse.json(body, { status }));
    const response = await handler(
      new NextRequest(`http://localhost/api/v2/apps/${CLIENT_ID}/billing/wallet`),
      ctx,
    );
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), body);
  }
});
