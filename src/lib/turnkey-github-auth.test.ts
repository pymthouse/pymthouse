import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { isGithubTurnkeyLoginConfigured } from "@/lib/turnkey-github-auth";

const KEYS = [
  "NEXT_PUBLIC_ORGANIZATION_ID",
  "NEXT_PUBLIC_AUTH_PROXY_CONFIG_ID",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "TURNKEY_API_PUBLIC_KEY",
  "TURNKEY_API_PRIVATE_KEY",
  "NEXT_PUBLIC_GITHUB_CLIENT_ID",
] as const;

describe("isGithubTurnkeyLoginConfigured", () => {
  const snapshot = Object.fromEntries(
    KEYS.map((k) => [k, process.env[k]]),
  ) as Record<(typeof KEYS)[number], string | undefined>;

  afterEach(() => {
    for (const key of KEYS) {
      const prev = snapshot[key];
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  });

  it("requires Turnkey wallet kit, GitHub OAuth, and Turnkey API keys", () => {
    for (const key of KEYS) delete process.env[key];
    assert.equal(isGithubTurnkeyLoginConfigured(), false);

    process.env.NEXT_PUBLIC_ORGANIZATION_ID = "org";
    process.env.NEXT_PUBLIC_AUTH_PROXY_CONFIG_ID = "cfg";
    assert.equal(isGithubTurnkeyLoginConfigured(), false);

    process.env.GITHUB_CLIENT_ID = "gh-client";
    process.env.GITHUB_CLIENT_SECRET = "gh-secret";
    assert.equal(isGithubTurnkeyLoginConfigured(), false);

    process.env.TURNKEY_API_PUBLIC_KEY = "pk";
    process.env.TURNKEY_API_PRIVATE_KEY = "sk";
    assert.equal(isGithubTurnkeyLoginConfigured(), true);
  });
});
