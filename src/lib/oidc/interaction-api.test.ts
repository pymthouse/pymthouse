import assert from "node:assert/strict";
import test from "node:test";

import {
  clearOidcSessionPrincipalIfMismatch,
  parseOidcInteractionUid,
} from "@/lib/oidc/interaction-api";

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

test("clearOidcSessionPrincipalIfMismatch no-ops when principals already match", async () => {
  let findCalls = 0;
  const provider = {
    Session: {
      findByUid: async () => {
        findCalls += 1;
        return null;
      },
    },
  };
  await clearOidcSessionPrincipalIfMismatch(
    provider as never,
    { uid: "s1", accountId: "acct-a" },
    "acct-a",
  );
  assert.equal(findCalls, 0);
});

test("clearOidcSessionPrincipalIfMismatch clears a stale OIDC principal", async () => {
  const session = {
    accountId: "stale-user",
    authorizations: { dcr_x: { grantId: "g1" } },
    loginTs: 123,
    persist: async () => undefined,
  };
  let persisted = false;
  session.persist = async () => {
    persisted = true;
  };
  const provider = {
    Session: {
      findByUid: async (uid: string) => {
        assert.equal(uid, "sess-uid");
        return session;
      },
    },
  };
  await clearOidcSessionPrincipalIfMismatch(
    provider as never,
    { uid: "sess-uid", accountId: "stale-user" },
    "nextauth-user",
  );
  assert.equal(session.accountId, undefined);
  assert.equal(session.authorizations, undefined);
  assert.equal(session.loginTs, undefined);
  assert.equal(persisted, true);
});
