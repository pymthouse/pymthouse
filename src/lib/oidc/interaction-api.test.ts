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

test("interaction completion is a POST path, not a GET complete query", async () => {
  const { oidcInteractionSubmitPath } = await import(
    "@/lib/oidc/interaction-path"
  );
  const path = oidcInteractionSubmitPath("uid-1");
  assert.equal(path.startsWith("/api/v1/oidc/interaction/"), true);
  assert.equal(path.includes("?"), false);
});
