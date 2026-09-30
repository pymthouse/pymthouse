import assert from "node:assert/strict";
import test from "node:test";

import { truncateMiddle } from "@/lib/truncate-middle";

test("truncateMiddle leaves short ids unchanged", () => {
  assert.equal(truncateMiddle("eu_short", 24), "eu_short");
  assert.equal(truncateMiddle("abc", 3), "abc");
  assert.equal(truncateMiddle("", 24), "");
});

test("truncateMiddle keeps the start and end of long ids", () => {
  const id = "eu_43eac8e3fe4dd854633da7a23fb";
  const shown = truncateMiddle(id, 24);
  assert.equal(shown.length, 24);
  assert.equal(shown.startsWith("eu_"), true);
  assert.equal(shown.endsWith("a23fb"), true);
  assert.equal(shown.includes("…"), true);
  assert.notEqual(shown, id);
  assert.equal(shown, `${id.slice(0, 12)}…${id.slice(-11)}`);
});

test("truncateMiddle rejects non-positive budgets", () => {
  assert.equal(truncateMiddle("eu_abc", 0), "");
  assert.equal(truncateMiddle("eu_abc", -1), "");
  assert.equal(truncateMiddle("eu_abc", 2), "eu");
});
