import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  consumeTurnkeyOauthRedirect,
  hasTurnkeyOauthReturnParams,
  isTurnkeyOauthCallbackPath,
  oauthCallbackResumeUrl,
  parseTurnkeyOauthRedirect,
  peekTurnkeyOauthRedirect,
  shouldResumeTurnkeyOauthCallback,
  storeTurnkeyOauthRedirect,
  takeTurnkeyOauthRedirectOnce,
  turnkeyOauthOpenInPageParams,
  TURNKEY_OAUTH_CALLBACK_PATH,
  TURNKEY_OAUTH_REDIRECT_STORAGE_KEY,
} from "./turnkey-oauth-redirect";

class MemoryStorage {
  private readonly data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }
}

describe("turnkeyOauthOpenInPageParams", () => {
  it("forces same-tab redirect and sanitizes callbackUrl", () => {
    assert.deepEqual(turnkeyOauthOpenInPageParams("/apps?x=1"), {
      openInPage: true,
      additionalState: { callbackUrl: "/apps?x=1" },
    });
    assert.deepEqual(
      turnkeyOauthOpenInPageParams("https://evil.example/phish"),
      {
        openInPage: true,
        additionalState: { callbackUrl: "/onboarding" },
      },
    );
  });
});

describe("parseTurnkeyOauthRedirect", () => {
  it("reads a stored callback path and rejects junk", () => {
    assert.equal(parseTurnkeyOauthRedirect(null), null);
    assert.equal(parseTurnkeyOauthRedirect("not-json"), null);
    assert.equal(parseTurnkeyOauthRedirect("{}"), null);
    assert.deepEqual(
      parseTurnkeyOauthRedirect(JSON.stringify({ callbackUrl: "/oidc/device" })),
      { callbackUrl: "/oidc/device" },
    );
    assert.deepEqual(
      parseTurnkeyOauthRedirect(
        JSON.stringify({ callbackUrl: "https://evil.example" }),
      ),
      { callbackUrl: "/onboarding" },
    );
  });
});

describe("turnkey oauth redirect sessionStorage", { concurrency: false }, () => {
  const previous = globalThis.sessionStorage;

  afterEach(() => {
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: previous,
    });
  });

  it("stores, peeks, and consumes the pending redirect", () => {
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: new MemoryStorage(),
    });

    storeTurnkeyOauthRedirect({ callbackUrl: "/onboarding?persona=builder" });
    assert.equal(
      sessionStorage.getItem(TURNKEY_OAUTH_REDIRECT_STORAGE_KEY)?.includes(
        "persona=builder",
      ),
      true,
    );
    assert.deepEqual(peekTurnkeyOauthRedirect(), {
      callbackUrl: "/onboarding?persona=builder",
    });
    assert.deepEqual(consumeTurnkeyOauthRedirect(), {
      callbackUrl: "/onboarding?persona=builder",
    });
    assert.equal(peekTurnkeyOauthRedirect(), null);
  });

  it("reuses the first take across a second consume (Strict Mode)", () => {
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: new MemoryStorage(),
    });
    storeTurnkeyOauthRedirect({ callbackUrl: "/apps" });
    assert.deepEqual(takeTurnkeyOauthRedirectOnce(), { callbackUrl: "/apps" });
    assert.deepEqual(takeTurnkeyOauthRedirectOnce(), { callbackUrl: "/apps" });
    assert.equal(peekTurnkeyOauthRedirect(), null);
  });
});

describe("hasTurnkeyOauthReturnParams", () => {
  it("detects Google hash returns and Discord query returns", () => {
    assert.equal(
      hasTurnkeyOauthReturnParams(
        "http://localhost:3001/auth/callback#id_token=abc&state=provider%3Dgoogle",
      ),
      true,
    );
    assert.equal(
      hasTurnkeyOauthReturnParams(
        "http://localhost:3001/?code=abc&state=provider%3Ddiscord",
      ),
      true,
    );
    assert.equal(hasTurnkeyOauthReturnParams("http://localhost:3001/login"), false);
    assert.equal(
      hasTurnkeyOauthReturnParams("http://localhost:3001/login?error=access_denied"),
      false,
    );
  });
});

describe("shouldResumeTurnkeyOauthCallback", () => {
  it("resumes only after a same-tab OAuth return outside /auth/callback", () => {
    assert.equal(isTurnkeyOauthCallbackPath(TURNKEY_OAUTH_CALLBACK_PATH), true);
    assert.equal(
      oauthCallbackResumeUrl("/apps"),
      "/auth/callback?callbackUrl=%2Fapps",
    );

    const base = {
      pathname: "/",
      hasPendingRedirect: true,
      turnkeyAuthenticated: true,
      nextAuthAuthenticated: false,
      sawOauthReturnParams: true,
    };
    assert.equal(shouldResumeTurnkeyOauthCallback(base), true);
    assert.equal(
      shouldResumeTurnkeyOauthCallback({
        ...base,
        pathname: TURNKEY_OAUTH_CALLBACK_PATH,
      }),
      false,
    );
    assert.equal(
      shouldResumeTurnkeyOauthCallback({
        ...base,
        sawOauthReturnParams: false,
      }),
      false,
    );
    assert.equal(
      shouldResumeTurnkeyOauthCallback({
        ...base,
        hasPendingRedirect: false,
      }),
      false,
    );
    assert.equal(
      shouldResumeTurnkeyOauthCallback({
        ...base,
        nextAuthAuthenticated: true,
      }),
      false,
    );
  });
});
