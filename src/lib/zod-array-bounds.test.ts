import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("patched zod bounds invalid array parsing", async () => {
  const patched = spawnSync(
    process.execPath,
    ["scripts/patch-zod-array-bounds.mjs"],
    { stdio: "inherit" },
  );
  assert.equal(patched.status, 0);

  const { z } = await import("zod");
  const manyInvalid = Array.from({ length: 500 }, () => 1);
  const issues = z.array(z.string()).safeParse(manyInvalid);
  assert.equal(issues.success, false);
  if (!issues.success) {
    assert.ok(issues.error.issues.length > 0);
    assert.ok(issues.error.issues.length <= 100);
  }

  const sparse: unknown[] = [];
  sparse[100_001] = "x";
  const tooBig = z.array(z.string()).safeParse(sparse);
  assert.equal(tooBig.success, false);
  if (!tooBig.success) {
    assert.equal(tooBig.error.issues.length, 1);
    assert.equal(tooBig.error.issues[0]?.code, "too_big");
  }

  const ok = z.array(z.string()).safeParse(["a", "b"]);
  assert.equal(ok.success, true);
});
