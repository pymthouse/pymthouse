import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

import { createAppScopedGet } from "@/lib/http/app-scoped-get";

test("createAppScopedGet 404s on blank id and forwards trimmed client id", async () => {
  const seen: string[] = [];
  const GET = createAppScopedGet(async (_request, clientId) => {
    seen.push(clientId);
    return Response.json({ clientId });
  });

  const missing = await GET(
    new NextRequest("http://localhost/api/v1/apps//me/billing/wallet"),
    { params: Promise.resolve({ id: "  " }) },
  );
  assert.equal(missing.status, 404);

  const ok = await GET(
    new NextRequest("http://localhost/api/v1/apps/app_1/me/billing/wallet"),
    { params: Promise.resolve({ id: " app_1 " }) },
  );
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { clientId: "app_1" });
  assert.deepEqual(seen, ["app_1"]);
});
