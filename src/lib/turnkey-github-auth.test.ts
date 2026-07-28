import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createHash } from "node:crypto";
import {
  exchangeGithubOAuthCode,
  fetchGithubUserProfile,
  getGithubOAuthClientId,
  getGithubOAuthClientSecret,
  githubAuthorizeUrl,
  githubOAuthCallbackUrl,
  isGithubTurnkeyLoginConfigured,
  loginTurnkeyWithGithub,
} from "@/lib/turnkey-github-auth";

const KEYS = [
  "NEXT_PUBLIC_ORGANIZATION_ID",
  "NEXT_PUBLIC_AUTH_PROXY_CONFIG_ID",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "TURNKEY_API_PUBLIC_KEY",
  "TURNKEY_API_PRIVATE_KEY",
  "NEXT_PUBLIC_GITHUB_CLIENT_ID",
  "NEXTAUTH_URL",
  "TURNKEY_ORG_ID",
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("isGithubTurnkeyLoginConfigured", () => {
  const snapshot = snapshotEnv();

  afterEach(() => {
    restoreEnv(snapshot);
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

  it("accepts NEXT_PUBLIC_GITHUB_CLIENT_ID as the OAuth client id", () => {
    for (const key of KEYS) delete process.env[key];
    process.env.NEXT_PUBLIC_ORGANIZATION_ID = "org";
    process.env.NEXT_PUBLIC_AUTH_PROXY_CONFIG_ID = "cfg";
    process.env.NEXT_PUBLIC_GITHUB_CLIENT_ID = "public-gh";
    process.env.GITHUB_CLIENT_SECRET = "gh-secret";
    process.env.TURNKEY_API_PUBLIC_KEY = "pk";
    process.env.TURNKEY_API_PRIVATE_KEY = "sk";
    assert.equal(getGithubOAuthClientId(), "public-gh");
    assert.equal(getGithubOAuthClientSecret(), "gh-secret");
    assert.equal(isGithubTurnkeyLoginConfigured(), true);
  });
});

describe("githubAuthorizeUrl / githubOAuthCallbackUrl", () => {
  const snapshot = snapshotEnv();

  afterEach(() => {
    restoreEnv(snapshot);
  });

  it("builds GitHub authorize URL with callback, scope, and state", () => {
    process.env.NEXTAUTH_URL = "https://app.example.com";
    const url = new URL(
      githubAuthorizeUrl({
        state: "sealed.state",
        clientId: "client-123",
      }),
    );
    assert.equal(url.origin, "https://github.com");
    assert.equal(url.pathname, "/login/oauth/authorize");
    assert.equal(url.searchParams.get("client_id"), "client-123");
    assert.equal(
      url.searchParams.get("redirect_uri"),
      "https://app.example.com/api/auth/github/callback",
    );
    assert.equal(url.searchParams.get("scope"), "read:user user:email");
    assert.equal(url.searchParams.get("state"), "sealed.state");
    assert.equal(
      githubOAuthCallbackUrl(),
      "https://app.example.com/api/auth/github/callback",
    );
  });
});

describe("exchangeGithubOAuthCode", () => {
  const snapshot = snapshotEnv();
  let originalFetch: typeof globalThis.fetch;

  afterEach(() => {
    restoreEnv(snapshot);
    if (originalFetch) globalThis.fetch = originalFetch;
  });

  it("exchanges a code for an access token", async () => {
    process.env.NEXTAUTH_URL = "https://app.example.com";
    process.env.GITHUB_CLIENT_ID = "cid";
    process.env.GITHUB_CLIENT_SECRET = "fixture-client-secret";
    originalFetch = globalThis.fetch;
    let posted: unknown;
    globalThis.fetch = async (_input, init) => {
      posted = JSON.parse(String(init?.body));
      return jsonResponse({ access_token: "gho_token" });
    };

    const result = await exchangeGithubOAuthCode("code-abc");
    assert.equal(result.accessToken, "gho_token");
    assert.deepEqual(posted, {
      client_id: "cid",
      client_secret: "fixture-client-secret",
      code: "code-abc",
      redirect_uri: "https://app.example.com/api/auth/github/callback",
    });
  });

  it("throws when OAuth is not configured", async () => {
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.NEXT_PUBLIC_GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
    await assert.rejects(
      () => exchangeGithubOAuthCode("code"),
      /GitHub OAuth is not configured/,
    );
  });

  it("throws on HTTP failure and missing access_token", async () => {
    process.env.NEXTAUTH_URL = "https://app.example.com";
    process.env.GITHUB_CLIENT_ID = "cid";
    process.env.GITHUB_CLIENT_SECRET = "fixture-client-secret";
    originalFetch = globalThis.fetch;

    globalThis.fetch = async () => jsonResponse({}, 503);
    await assert.rejects(
      () => exchangeGithubOAuthCode("code"),
      /GitHub token exchange failed \(503\)/,
    );

    globalThis.fetch = async () =>
      jsonResponse({ error: "bad_verification_code", error_description: "nope" });
    await assert.rejects(() => exchangeGithubOAuthCode("code"), /nope/);
  });
});

describe("fetchGithubUserProfile", () => {
  let originalFetch: typeof globalThis.fetch;

  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch;
  });

  it("returns profile when email is present on /user", async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      assert.ok(url.includes("api.github.com/user"));
      return jsonResponse({
        id: 42,
        login: "octocat",
        name: "The Octocat",
        email: "octo@example.com",
      });
    };

    const profile = await fetchGithubUserProfile("token");
    assert.deepEqual(profile, {
      id: 42,
      login: "octocat",
      name: "The Octocat",
      email: "octo@example.com",
    });
  });

  it("falls back to primary verified email from /user/emails", async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/user")) {
        return jsonResponse({
          id: 7,
          login: "hubber",
          name: null,
          email: null,
        });
      }
      if (url.endsWith("/user/emails")) {
        return jsonResponse([
          { email: "other@ex.com", primary: false, verified: true },
          { email: "primary@ex.com", primary: true, verified: true },
        ]);
      }
      throw new Error(`unexpected ${url}`);
    };

    const profile = await fetchGithubUserProfile("token");
    assert.equal(profile.email, "primary@ex.com");
    assert.equal(profile.name, null);
  });

  it("throws when /user is missing id/login or HTTP fails", async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = async () => jsonResponse({}, 401);
    await assert.rejects(
      () => fetchGithubUserProfile("token"),
      /GitHub user lookup failed \(401\)/,
    );

    globalThis.fetch = async () => jsonResponse({ login: "x" });
    await assert.rejects(
      () => fetchGithubUserProfile("token"),
      /missing id\/login/,
    );
  });
});

describe("loginTurnkeyWithGithub", () => {
  const snapshot = snapshotEnv();

  afterEach(() => {
    restoreEnv(snapshot);
  });

  it("rejects when nonce does not match the session public key", async () => {
    const publicKey =
      "0394e549c71fa99dd5cf752fba623090be314949b74e4cdf7ca72031dd638e281a";
    await assert.rejects(
      () =>
        loginTurnkeyWithGithub({
          publicKey,
          nonce: "deadbeef",
          profile: {
            id: 1,
            login: "u",
            name: null,
            email: null,
          },
        }),
      /OAuth nonce does not match session public key/,
    );
  });

  it("rejects when parent organization id is missing", async () => {
    delete process.env.TURNKEY_ORG_ID;
    delete process.env.NEXT_PUBLIC_ORGANIZATION_ID;
    const publicKey =
      "0394e549c71fa99dd5cf752fba623090be314949b74e4cdf7ca72031dd638e281a";
    const nonce = createHash("sha256").update(publicKey, "utf8").digest("hex");
    await assert.rejects(
      () =>
        loginTurnkeyWithGithub({
          publicKey,
          nonce,
          profile: {
            id: 1,
            login: "u",
            name: null,
            email: null,
          },
        }),
      /Missing TURNKEY_ORG_ID/,
    );
  });
});
