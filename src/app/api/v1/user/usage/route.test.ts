import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

test("end-user usage routes reject subject overrides and require auth", async () => {
  const usage = await import("./route");
  const balance = await import("./balance/route");

  for (const [label, GET] of [
    ["usage", usage.GET],
    ["balance", balance.GET],
  ] as const) {
    const noAuth = await GET(
      new NextRequest(`http://localhost/api/v1/user/${label}`),
    );
    assert.equal(noAuth.status, 401, `${label} requires auth`);

    for (const key of ["userId", "externalUserId", "external_user_id"]) {
      const overridden = await GET(
        new NextRequest(
          `http://localhost/api/v1/user/${label}?${key}=other-user`,
        ),
      );
      assert.equal(overridden.status, 400, `${label} rejects ${key}`);
      const body = (await overridden.json()) as { error?: string };
      assert.match(body.error ?? "", /userId\/externalUserId/);
    }
  }
});
