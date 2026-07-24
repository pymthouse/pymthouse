import test from "node:test";
import assert from "node:assert/strict";

const skipDb = !(
  process.env.DATABASE_URL && process.env.PYMTHOUSE_TEST_DATABASE_URL_UNSET !== "1"
);

test(
  "authenticateRequestAsync still accepts pmth bearer tokens",
  { skip: skipDb },
  async () => {
    const { createSession, authenticateRequestAsync } = await import("./auth");
    const { token } = await createSession({
      scopes: "sign:job",
      expiresInDays: 1,
    });

    const request = {
      headers: new Headers({
        authorization: `Bearer ${token}`,
      }),
    } as any;

    const auth = await authenticateRequestAsync(request);
    assert.ok(auth);
    assert.equal(auth.scopes, "sign:job");
  },
);
