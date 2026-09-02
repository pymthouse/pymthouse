import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  clearTurnkeyOauthRedirect,
  consumeTurnkeyOauthRedirect,
  extractTurnkeyOauthUrlReturn,
  hasTurnkeyOauthErrorReturn,
  hasTurnkeyOauthReturnParams,
  isTurnkeyOauthCallbackPath,
  isTurnkeyWalletKitRedirectState,
  oauthCallbackResumeUrl,
  parseOauthStatePairs,
  parseTurnkeyOauthRedirect,
  peekTurnkeyOauthRedirect,
  sha256Hex,
  shouldResumeTurnkeyOauthCallback,
  storeTurnkeyOauthRedirect,
  takeTurnkeyOauthRedirectOnce,
  turnkeyOauthOpenInPageParams,
  TURNKEY_OAUTH_CALLBACK_PATH,
  TURNKEY_OAUTH_REDIRECT_STORAGE_KEY,
  TURNKEY_OAUTH_REDIRECT_TTL_MS,
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

const KIT_GOOGLE_STATE =
  "provider=google&flow=redirect&publicKey=abc123&resume=resume-token-1";
const KIT_DISCORD_STATE =
  "provider=discord&flow=redirect&publicKey=abc123&resume=resume-token-1";

function encodeState(state: string): string {
  return encodeURIComponent(state);
}

function pending(overrides?: {
  callbackUrl?: string;
  resumeDigest?: string;
  startedAt?: number;
}): {
  callbackUrl: string;
  resumeDigest: string;
  startedAt: number;
} {
  return {
    callbackUrl: "/apps",
    resumeDigest: "pending-digest",
    startedAt: Date.now(),
    ...overrides,
  };
}

describe("turnkeyOauthOpenInPageParams", { concurrency: false }, () => {
  const previous = globalThis.sessionStorage;

  afterEach(() => {
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: previous,
    });
  });

  it("forces same-tab redirect, stores resume CSRF, and sanitizes callbackUrl", async () => {
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: new MemoryStorage(),
    });

    const params = await turnkeyOauthOpenInPageParams("/apps?x=1");
    assert.equal(params.openInPage, true);
    assert.equal(params.additionalState.callbackUrl, "/apps?x=1");
    assert.equal(typeof params.additionalState.resume, "string");
    assert.equal(params.additionalState.resume.length > 8, true);
    const stored = peekTurnkeyOauthRedirect();
    assert.equal(stored?.callbackUrl, "/apps?x=1");
    assert.equal(
      stored?.resumeDigest,
      await sha256Hex(params.additionalState.resume),
    );

    const rejected = await turnkeyOauthOpenInPageParams("https://evil.example/phish");
    assert.equal(rejected.additionalState.callbackUrl, "/onboarding");
  });
});

describe("parseTurnkeyOauthRedirect", () => {
  it("reads a stored callback path and rejects junk", () => {
    assert.equal(parseTurnkeyOauthRedirect(null), null);
    assert.equal(parseTurnkeyOauthRedirect("not-json"), null);
    assert.equal(parseTurnkeyOauthRedirect("{}"), null);
    assert.equal(
      parseTurnkeyOauthRedirect(JSON.stringify({ callbackUrl: "/oidc/device" })),
      null,
    );
    assert.deepEqual(
      parseTurnkeyOauthRedirect(
        JSON.stringify({
          callbackUrl: "/oidc/device",
          resumeDigest: "tok",
          startedAt: 1,
        }),
      ),
      { callbackUrl: "/oidc/device", resumeDigest: "tok", startedAt: 1 },
    );
    assert.deepEqual(
      parseTurnkeyOauthRedirect(
        JSON.stringify({
          callbackUrl: "https://evil.example",
          resumeDigest: "tok",
          startedAt: 1,
        }),
      ),
      { callbackUrl: "/onboarding", resumeDigest: "tok", startedAt: 1 },
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

    storeTurnkeyOauthRedirect({
      callbackUrl: "/onboarding?persona=builder",
      resumeDigest: "tok",
    });
    assert.equal(
      sessionStorage.getItem(TURNKEY_OAUTH_REDIRECT_STORAGE_KEY)?.includes(
        "persona=builder",
      ),
      true,
    );
    const peeked = peekTurnkeyOauthRedirect();
    assert.equal(peeked?.callbackUrl, "/onboarding?persona=builder");
    assert.equal(peeked?.resumeDigest, "tok");
    assert.equal(consumeTurnkeyOauthRedirect()?.callbackUrl, "/onboarding?persona=builder");
    assert.equal(peekTurnkeyOauthRedirect(), null);
  });

  it("reuses the first take across a second consume (Strict Mode)", () => {
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: new MemoryStorage(),
    });
    storeTurnkeyOauthRedirect({ callbackUrl: "/apps", resumeDigest: "tok" });
    assert.equal(takeTurnkeyOauthRedirectOnce()?.callbackUrl, "/apps");
    assert.equal(takeTurnkeyOauthRedirectOnce()?.callbackUrl, "/apps");
    assert.equal(peekTurnkeyOauthRedirect(), null);
  });

  it("expires stale pending flags and ignores payloads without resume CSRF", () => {
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: new MemoryStorage(),
    });
    storeTurnkeyOauthRedirect({
      callbackUrl: "/apps",
      resumeDigest: "tok",
      startedAt: Date.now() - TURNKEY_OAUTH_REDIRECT_TTL_MS - 1,
    });
    assert.equal(peekTurnkeyOauthRedirect(), null);
    assert.equal(sessionStorage.getItem(TURNKEY_OAUTH_REDIRECT_STORAGE_KEY), null);

    sessionStorage.setItem(
      TURNKEY_OAUTH_REDIRECT_STORAGE_KEY,
      JSON.stringify({ callbackUrl: "/apps" }),
    );
    assert.equal(peekTurnkeyOauthRedirect(), null);
  });

  it("clearTurnkeyOauthRedirect drops the pending flag", () => {
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: new MemoryStorage(),
    });
    storeTurnkeyOauthRedirect({ callbackUrl: "/apps", resumeDigest: "tok" });
    clearTurnkeyOauthRedirect();
    assert.equal(peekTurnkeyOauthRedirect(), null);
  });
});

describe("hasTurnkeyOauthReturnParams", () => {
  it("detects Wallet Kit Google hash and Discord query returns", () => {
    assert.equal(
      hasTurnkeyOauthReturnParams(
        `http://localhost:3001/auth/callback#id_token=abc&state=${encodeState(KIT_GOOGLE_STATE)}`,
      ),
      true,
    );
    assert.equal(
      hasTurnkeyOauthReturnParams(
        `http://localhost:3001/?code=abc&state=${encodeState(KIT_DISCORD_STATE)}`,
      ),
      true,
    );
    assert.equal(
      hasTurnkeyOauthReturnParams(
        "http://localhost:3001/#state=provider=apple&flow=redirect&publicKey=abc123&resume=resume-token-1&code=c&id_token=jwt",
      ),
      true,
    );
    assert.equal(
      extractTurnkeyOauthUrlReturn(
        `http://localhost:3001/?code=abc&state=${encodeState(KIT_DISCORD_STATE)}`,
      )?.resume,
      "resume-token-1",
    );
  });

  it("rejects random hashes, generic OIDC pairs, and error returns", () => {
    assert.equal(hasTurnkeyOauthReturnParams("http://localhost:3001/login"), false);
    assert.equal(
      hasTurnkeyOauthReturnParams("http://localhost:3001/login#section"),
      false,
    );
    assert.equal(
      hasTurnkeyOauthReturnParams("http://localhost:3001/login#foo=bar"),
      false,
    );
    assert.equal(
      hasTurnkeyOauthReturnParams(
        "http://localhost:3001/login?code=abc&state=xyz",
      ),
      false,
    );
    assert.equal(
      hasTurnkeyOauthReturnParams(
        "http://localhost:3001/login?error=access_denied",
      ),
      false,
    );
    assert.equal(
      hasTurnkeyOauthErrorReturn(
        `http://localhost:3001/login?error=access_denied&state=${encodeState(KIT_GOOGLE_STATE)}`,
      ),
      true,
    );
    assert.equal(
      hasTurnkeyOauthReturnParams(
        `http://localhost:3001/login?error=access_denied&state=${encodeState(KIT_GOOGLE_STATE)}`,
      ),
      false,
    );
    assert.equal(
      isTurnkeyWalletKitRedirectState("provider=google&flow=popup&publicKey=abc"),
      false,
    );
    const parsed = parseOauthStatePairs(
      "provider=google&flow=redirect&publicKey=abc&__proto__=polluted&constructor=pwn&resume=x",
    );
    assert.deepEqual(parsed, {
      provider: "google",
      flow: "redirect",
      publicKey: "abc",
      resume: "x",
    });
    assert.equal(Object.hasOwn(parsed, "__proto__"), false);
    assert.equal(Object.hasOwn(parsed, "constructor"), false);
  });
});

describe("shouldResumeTurnkeyOauthCallback", () => {
  it("resumes only after a matching same-tab OAuth return outside /auth/callback", async () => {
    assert.equal(isTurnkeyOauthCallbackPath(TURNKEY_OAUTH_CALLBACK_PATH), true);
    assert.equal(
      oauthCallbackResumeUrl("/apps"),
      "/auth/callback?callbackUrl=%2Fapps",
    );

    const href = `http://localhost:3001/#id_token=abc&state=${encodeState(KIT_GOOGLE_STATE)}`;
    const base = {
      pathname: "/",
      href,
      pending: pending({
        resumeDigest: await sha256Hex("resume-token-1"),
      }),
      turnkeyAuthenticated: true,
      nextAuthAuthenticated: false,
    };
    assert.equal(await shouldResumeTurnkeyOauthCallback(base), true);
    assert.equal(
      await shouldResumeTurnkeyOauthCallback({
        ...base,
        pathname: TURNKEY_OAUTH_CALLBACK_PATH,
      }),
      false,
    );
    assert.equal(
      await shouldResumeTurnkeyOauthCallback({
        ...base,
        href: "http://localhost:3001/#section",
      }),
      false,
    );
    assert.equal(
      await shouldResumeTurnkeyOauthCallback({
        ...base,
        pending: null,
      }),
      false,
    );
    assert.equal(
      await shouldResumeTurnkeyOauthCallback({
        ...base,
        pending: pending({ resumeDigest: "other-digest" }),
      }),
      false,
    );
    assert.equal(
      await shouldResumeTurnkeyOauthCallback({
        ...base,
        nextAuthAuthenticated: true,
      }),
      false,
    );
    assert.equal(
      await shouldResumeTurnkeyOauthCallback({
        ...base,
        href: `http://localhost:3001/?error=access_denied&state=${encodeState(KIT_GOOGLE_STATE)}`,
      }),
      false,
    );
  });
});
