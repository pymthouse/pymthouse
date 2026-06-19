import test from "node:test";
import assert from "node:assert/strict";

import {
  clampSignerRefreshTtlDays,
  resolveSignerJwtTtlSeconds,
  SIGNER_REFRESH_LABEL_PREFIX,
} from "./mint-user-signer-token";
import { parseSignerRefreshLabel } from "./signer-refresh";

function withEnv(value: string | undefined, fn: () => void) {
  const prev = process.env.SIGNER_JWT_TTL_SECONDS;
  if (value === undefined) {
    delete process.env.SIGNER_JWT_TTL_SECONDS;
  } else {
    process.env.SIGNER_JWT_TTL_SECONDS = value;
  }
  try {
    fn();
  } finally {
    if (prev === undefined) {
      delete process.env.SIGNER_JWT_TTL_SECONDS;
    } else {
      process.env.SIGNER_JWT_TTL_SECONDS = prev;
    }
  }
}

test("resolveSignerJwtTtlSeconds falls back to env default of 300 when unset", () => {
  withEnv(undefined, () => {
    assert.equal(resolveSignerJwtTtlSeconds(null), 300);
    assert.equal(resolveSignerJwtTtlSeconds(undefined), 300);
  });
});

test("resolveSignerJwtTtlSeconds honors the env default when no per-app override", () => {
  withEnv("1200", () => {
    assert.equal(resolveSignerJwtTtlSeconds(null), 1200);
  });
});

test("resolveSignerJwtTtlSeconds clamps env default to the 60..86400 range", () => {
  withEnv("5", () => assert.equal(resolveSignerJwtTtlSeconds(null), 60));
  withEnv("999999", () => assert.equal(resolveSignerJwtTtlSeconds(null), 86400));
  withEnv("not-a-number", () => assert.equal(resolveSignerJwtTtlSeconds(null), 300));
});

test("resolveSignerJwtTtlSeconds prefers the per-app override and clamps it", () => {
  withEnv("300", () => {
    assert.equal(resolveSignerJwtTtlSeconds(900), 900);
    assert.equal(resolveSignerJwtTtlSeconds(10), 60);
    assert.equal(resolveSignerJwtTtlSeconds(100000), 86400);
  });
});

test("clampSignerRefreshTtlDays defaults to 30 and clamps to 1..90", () => {
  assert.equal(clampSignerRefreshTtlDays(null), 30);
  assert.equal(clampSignerRefreshTtlDays(undefined), 30);
  assert.equal(clampSignerRefreshTtlDays(7), 7);
  assert.equal(clampSignerRefreshTtlDays(0), 1);
  assert.equal(clampSignerRefreshTtlDays(365), 90);
});

test("parseSignerRefreshLabel splits app id from external user id", () => {
  const parsed = parseSignerRefreshLabel(`${SIGNER_REFRESH_LABEL_PREFIX}app_123:user-abc`);
  assert.deepEqual(parsed, { developerAppId: "app_123", externalUserId: "user-abc" });
});

test("parseSignerRefreshLabel keeps colons inside the external user id", () => {
  const parsed = parseSignerRefreshLabel(
    `${SIGNER_REFRESH_LABEL_PREFIX}app_123:tenant:user:99`,
  );
  assert.deepEqual(parsed, {
    developerAppId: "app_123",
    externalUserId: "tenant:user:99",
  });
});

test("parseSignerRefreshLabel rejects non-signer-refresh and malformed labels", () => {
  assert.equal(parseSignerRefreshLabel("app_user_refresh:user-1"), null);
  assert.equal(parseSignerRefreshLabel(`${SIGNER_REFRESH_LABEL_PREFIX}app_123`), null);
  assert.equal(parseSignerRefreshLabel(`${SIGNER_REFRESH_LABEL_PREFIX}:user-1`), null);
  assert.equal(parseSignerRefreshLabel(`${SIGNER_REFRESH_LABEL_PREFIX}app_123:`), null);
});
