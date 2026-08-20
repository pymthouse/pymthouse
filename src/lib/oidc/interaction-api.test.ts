import assert from "node:assert/strict";
import test from "node:test";

import { parseOidcInteractionUid } from "@/lib/oidc/interaction-api";

test("parseOidcInteractionUid reads a provider interaction uid", () => {
  assert.equal(
    parseOidcInteractionUid("/interaction/W4hYOpuBXFIF3QMENLmR_86c9UGx-ysRiko5YKbvxs7"),
    "W4hYOpuBXFIF3QMENLmR_86c9UGx-ysRiko5YKbvxs7",
  );
});

test("parseOidcInteractionUid rejects other oidc paths", () => {
  assert.equal(parseOidcInteractionUid("/auth"), null);
  assert.equal(parseOidcInteractionUid("/interaction/"), null);
  assert.equal(parseOidcInteractionUid("/interaction/uid/extra"), null);
});
