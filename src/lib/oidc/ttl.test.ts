import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_OIDC_ACCESS_TOKEN_TTL_SECONDS,
  DEFAULT_OIDC_REFRESH_TOKEN_TTL_SECONDS,
  OIDC_ACCESS_TOKEN_TTL_ENV,
  OIDC_REFRESH_TOKEN_TTL_ENV,
  resolveOidcAccessTokenTtlSeconds,
  resolveOidcProviderTtls,
  resolveOidcRefreshTokenTtlSeconds,
  resolvePositiveIntegerSecondsEnv,
} from "./ttl";

const NINETY_DAYS = 90 * 24 * 3600;
const THIRTY_DAYS = 30 * 24 * 3600;

function withEnv(name: string, value: string | undefined, run: () => void): void {
  const previous = process.env[name];
  try {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
    run();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

test("resolvePositiveIntegerSecondsEnv uses fallback when unset", () => {
  withEnv("OIDC_TTL_TEST_UNSET", undefined, () => {
    assert.equal(resolvePositiveIntegerSecondsEnv("OIDC_TTL_TEST_UNSET", 42), 42);
  });
});

test("resolvePositiveIntegerSecondsEnv prefers a valid positive integer", () => {
  withEnv("OIDC_TTL_TEST_SET", "7776000", () => {
    assert.equal(
      resolvePositiveIntegerSecondsEnv("OIDC_TTL_TEST_SET", 3600),
      7776000,
    );
  });
});

test("resolvePositiveIntegerSecondsEnv ignores invalid, zero, and negative values", () => {
  for (const value of ["", "  ", "not-a-number", "0", "-1", "3600.5", "1e3"]) {
    withEnv("OIDC_TTL_TEST_INVALID", value, () => {
      assert.equal(
        resolvePositiveIntegerSecondsEnv("OIDC_TTL_TEST_INVALID", 99),
        99,
        `expected fallback for ${JSON.stringify(value)}`,
      );
    });
  }
});

test("access JWT defaults to 1 hour unless OIDC_ACCESS_TOKEN_TTL_SECONDS is set", () => {
  withEnv(OIDC_ACCESS_TOKEN_TTL_ENV, undefined, () => {
    assert.equal(
      resolveOidcAccessTokenTtlSeconds(),
      DEFAULT_OIDC_ACCESS_TOKEN_TTL_SECONDS,
    );
    assert.equal(resolveOidcAccessTokenTtlSeconds(), 3600);
  });
  withEnv(OIDC_ACCESS_TOKEN_TTL_ENV, "7200", () => {
    assert.equal(resolveOidcAccessTokenTtlSeconds(), 7200);
  });
});

test("refresh defaults to 90 days and can be set to 90 days via env", () => {
  withEnv(OIDC_REFRESH_TOKEN_TTL_ENV, undefined, () => {
    assert.equal(resolveOidcRefreshTokenTtlSeconds(), NINETY_DAYS);
    assert.equal(
      resolveOidcRefreshTokenTtlSeconds(),
      DEFAULT_OIDC_REFRESH_TOKEN_TTL_SECONDS,
    );
  });
  withEnv(OIDC_REFRESH_TOKEN_TTL_ENV, String(NINETY_DAYS), () => {
    assert.equal(resolveOidcRefreshTokenTtlSeconds(), NINETY_DAYS);
  });
  withEnv(OIDC_REFRESH_TOKEN_TTL_ENV, String(THIRTY_DAYS), () => {
    assert.equal(resolveOidcRefreshTokenTtlSeconds(), THIRTY_DAYS);
  });
});

test("grant and session TTLs are at least as long as refresh", () => {
  withEnv(OIDC_ACCESS_TOKEN_TTL_ENV, undefined, () => {
    withEnv(OIDC_REFRESH_TOKEN_TTL_ENV, String(NINETY_DAYS), () => {
      const ttls = resolveOidcProviderTtls();
      assert.equal(ttls.accessToken, 3600);
      assert.equal(ttls.refreshToken, NINETY_DAYS);
      assert.ok(ttls.grant >= ttls.refreshToken);
      assert.ok(ttls.session >= ttls.refreshToken);
      assert.equal(ttls.grant, ttls.refreshToken);
      assert.equal(ttls.session, ttls.refreshToken);
    });
  });
});

test("programmatic mint and signer JWTs stay on their own TTLs", async () => {
  const { PROGRAMMATIC_ACCESS_TOKEN_TTL_SECONDS, PROGRAMMATIC_REFRESH_TOKEN_TTL_DAYS } =
    await import("./programmatic-tokens");
  const { SIGNER_JWT_TTL_SECONDS } = await import("./mint-user-signer-token");

  withEnv(OIDC_ACCESS_TOKEN_TTL_ENV, "7200", () => {
    withEnv(OIDC_REFRESH_TOKEN_TTL_ENV, String(NINETY_DAYS), () => {
      const ttls = resolveOidcProviderTtls();
      assert.equal(PROGRAMMATIC_ACCESS_TOKEN_TTL_SECONDS, 15 * 60);
      assert.equal(PROGRAMMATIC_REFRESH_TOKEN_TTL_DAYS, 30);
      assert.equal(SIGNER_JWT_TTL_SECONDS, 300);
      assert.notEqual(PROGRAMMATIC_ACCESS_TOKEN_TTL_SECONDS, ttls.accessToken);
      assert.notEqual(
        PROGRAMMATIC_REFRESH_TOKEN_TTL_DAYS * 24 * 3600,
        ttls.refreshToken,
      );
    });
  });
});
