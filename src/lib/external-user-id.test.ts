import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  ExternalUserIdError,
  INVALID_EXTERNAL_USER_ID,
  isValidExternalUserId,
  parseExternalUserId,
} from "./external-user-id";

describe("parseExternalUserId", () => {
  test("accepts UUID and slug-like machine ids", () => {
    assert.equal(
      parseExternalUserId("5a5d8e06-d6ab-41f3-b557-7b4e15789b1a"),
      "5a5d8e06-d6ab-41f3-b557-7b4e15789b1a",
    );
    assert.equal(parseExternalUserId("user-naap-1"), "user-naap-1");
    assert.equal(parseExternalUserId("probe.slug_01"), "probe.slug_01");
  });

  test("rejects empty", () => {
    assert.throws(
      () => parseExternalUserId("  "),
      (err: unknown) =>
        err instanceof ExternalUserIdError &&
        err.code === INVALID_EXTERNAL_USER_ID,
    );
  });

  test("rejects email-shaped ids", () => {
    assert.throws(() => parseExternalUserId("a@b.co"), ExternalUserIdError);
    assert.throws(
      () => parseExternalUserId("demo@livepeer.org"),
      ExternalUserIdError,
    );
    assert.equal(isValidExternalUserId("demo@livepeer.org"), false);
  });

  test("rejects owner: and user: wire prefixes", () => {
    assert.throws(
      () => parseExternalUserId("owner:uuid-1"),
      ExternalUserIdError,
    );
    assert.throws(() => parseExternalUserId("user:uuid-1"), ExternalUserIdError);
  });
});
