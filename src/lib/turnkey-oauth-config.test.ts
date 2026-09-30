import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { buildTurnkeyWalletOauthAuthConfig } from "./turnkey-oauth-config";

const KEYS = [
  "NEXT_PUBLIC_TURNKEY_OAUTH_REDIRECT_URI",
  "NEXT_PUBLIC_OAUTH_REDIRECT_URI",
  "NEXT_PUBLIC_TURNKEY_GOOGLE_CLIENT_ID",
  "NEXT_PUBLIC_TURNKEY_APPLE_CLIENT_ID",
  "NEXT_PUBLIC_TURNKEY_DISCORD_CLIENT_ID",
  "NEXT_PUBLIC_TURNKEY_X_CLIENT_ID",
] as const;

function snapshotEnv(): Record<(typeof KEYS)[number], string | undefined> {
  return Object.fromEntries(KEYS.map((k) => [k, process.env[k]])) as Record<
    (typeof KEYS)[number],
    string | undefined
  >;
}

function restoreEnv(
  snapshot: Record<(typeof KEYS)[number], string | undefined>,
): void {
  for (const key of KEYS) {
    const prev = snapshot[key];
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

describe("buildTurnkeyWalletOauthAuthConfig", () => {
  const snapshot = snapshotEnv();

  afterEach(() => {
    restoreEnv(snapshot);
  });

  it("always opens OAuth in the current page even with no env overrides", () => {
    for (const key of KEYS) delete process.env[key];
    const auth = buildTurnkeyWalletOauthAuthConfig();
    assert.equal(auth.oauthConfig?.openOauthInPage, true);
    assert.equal(auth.oauthConfig?.oauthRedirectUri, undefined);
    assert.equal(auth.oauthConfig?.google, undefined);
  });

  it("prefers TURNKEY_OAUTH_REDIRECT_URI over OAUTH_REDIRECT_URI", () => {
    for (const key of KEYS) delete process.env[key];
    process.env.NEXT_PUBLIC_OAUTH_REDIRECT_URI =
      "http://localhost:3001/auth/callback";
    process.env.NEXT_PUBLIC_TURNKEY_OAUTH_REDIRECT_URI =
      "http://localhost:3001";
    const auth = buildTurnkeyWalletOauthAuthConfig();
    assert.equal(auth.oauthConfig?.oauthRedirectUri, "http://localhost:3001");
    assert.equal(auth.oauthConfig?.openOauthInPage, true);
  });

  it("includes provider client IDs when set", () => {
    for (const key of KEYS) delete process.env[key];
    process.env.NEXT_PUBLIC_TURNKEY_GOOGLE_CLIENT_ID = "google-client";
    process.env.NEXT_PUBLIC_TURNKEY_DISCORD_CLIENT_ID = "discord-client";
    const auth = buildTurnkeyWalletOauthAuthConfig();
    assert.deepEqual(auth.oauthConfig?.google, {
      primaryClientId: "google-client",
    });
    assert.deepEqual(auth.oauthConfig?.discord, {
      primaryClientId: "discord-client",
    });
  });
});
