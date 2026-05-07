import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const run =
  process.env.DATABASE_URL && process.env.PYMTHOUSE_TEST_DATABASE_URL_UNSET !== "1"
    ? test
    : test.skip;

run("upsert preserves consumed state for existing rows", async () => {
  const { PostgresOidcAdapter } = await import("./adapter");
  const adapter = new PostgresOidcAdapter("DeviceCode");
  const id = `device-code-consume-test-${crypto.randomUUID()}`;

  await adapter.upsert(
    id,
    {
      jti: id,
      userCode: "ABCD1234",
      clientId: "test-client",
    },
    600,
  );

  await adapter.consume(id);
  const consumed = await adapter.find(id);
  assert.ok(consumed?.consumed);

  await adapter.upsert(
    id,
    {
      jti: id,
      userCode: "ABCD1234",
      clientId: "test-client",
    },
    600,
  );

  const after = await adapter.find(id);
  assert.ok(after?.consumed, "consumed flag should not be cleared by upsert");
});
