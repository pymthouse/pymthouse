import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it, before, after } from "node:test";
import * as jose from "jose";
import {
  clearCookieOptions,
  createGithubOauthCsrf,
  githubAuthCookieOptions,
  githubOauthStateCookieOptions,
  githubSessionHandoffCookieOptions,
  openGithubOauthState,
  sealGithubOauthState,
} from "@/lib/turnkey-github-cookies";
import {
  buildTurnkeyGithubOpenIdConfiguration,
  getTurnkeyGithubOidcIssuer,
  githubOidcSubject,
  mintTurnkeyGithubOidcToken,
  TURNKEY_GITHUB_OIDC_AUDIENCE,
  TURNKEY_GITHUB_OIDC_MOUNT,
  turnkeyOauthNonceFromPublicKey,
} from "@/lib/turnkey-github-oidc";

describe("turnkeyOauthNonceFromPublicKey", () => {
  it("matches Wallet Kit sha256(utf8(publicKey)) hex", () => {
    const publicKey =
      "0394e549c71fa99dd5cf752fba623090be314949b74e4cdf7ca72031dd638e281a";
    const expected = createHash("sha256")
      .update(publicKey, "utf8")
      .digest("hex");
    assert.equal(turnkeyOauthNonceFromPublicKey(publicKey), expected);
    assert.equal(
      expected,
      "1663bba492a323085b13895634a3618792c4ec6896f3c34ef3c26396df22ef82",
    );
  });
});

describe("githubOidcSubject", () => {
  it("prefixes github user ids", () => {
    assert.equal(githubOidcSubject(12345), "github:12345");
    assert.equal(githubOidcSubject("99"), "github:99");
  });
});

describe("GitHub OAuth state cookies", () => {
  const prevSecret = process.env.NEXTAUTH_SECRET;
  const prevNextAuthUrl = process.env.NEXTAUTH_URL;

  before(() => {
    process.env.NEXTAUTH_SECRET = "test-secret-for-github-oauth-state-cookies";
  });

  after(() => {
    if (prevSecret === undefined) delete process.env.NEXTAUTH_SECRET;
    else process.env.NEXTAUTH_SECRET = prevSecret;
    if (prevNextAuthUrl === undefined) delete process.env.NEXTAUTH_URL;
    else process.env.NEXTAUTH_URL = prevNextAuthUrl;
  });

  it("round-trips sealed state and rejects tampering", () => {
    const csrf = createGithubOauthCsrf();
    const sealed = sealGithubOauthState({
      publicKey: "02".padEnd(66, "ab"),
      nonce: "abc",
      callbackUrl: "/onboarding",
      csrf,
    });
    const opened = openGithubOauthState(sealed);
    assert.ok(opened);
    assert.equal(opened.csrf, csrf);
    assert.equal(opened.callbackUrl, "/onboarding");
    assert.equal(opened.nonce, "abc");

    assert.equal(openGithubOauthState(sealed.slice(0, -2) + "xx"), null);
    assert.equal(openGithubOauthState("not-valid"), null);
    assert.equal(openGithubOauthState("a.b.c"), null);
  });

  it("rejects unsafe callback URLs", () => {
    const sealed = sealGithubOauthState({
      publicKey: "02".padEnd(66, "cd"),
      nonce: "n",
      callbackUrl: "https://evil.example",
      csrf: createGithubOauthCsrf(),
    });
    const opened = openGithubOauthState(sealed);
    assert.ok(opened);
    assert.equal(opened.callbackUrl, "/onboarding");
  });

  it("rejects expired sealed state", () => {
    const sealed = sealGithubOauthState({
      publicKey: "02".padEnd(66, "ef"),
      nonce: "n",
      callbackUrl: "/apps",
      csrf: createGithubOauthCsrf(),
      exp: Date.now() - 1_000,
    });
    assert.equal(openGithubOauthState(sealed), null);
  });

  it("sets secure cookie flags from NEXTAUTH_URL", () => {
    process.env.NEXTAUTH_URL = "https://preview.example.com";
    assert.equal(githubAuthCookieOptions(30).secure, true);
    assert.equal(githubOauthStateCookieOptions().httpOnly, true);
    assert.equal(githubSessionHandoffCookieOptions().sameSite, "lax");
    assert.equal(clearCookieOptions().maxAge, 0);

    process.env.NEXTAUTH_URL = "http://localhost:3000";
    assert.equal(githubAuthCookieOptions(30).secure, false);
  });
});

describe("Turnkey GitHub OIDC issuer", () => {
  const prevIssuer = process.env.TURNKEY_GITHUB_OIDC_ISSUER;

  after(() => {
    if (prevIssuer === undefined) delete process.env.TURNKEY_GITHUB_OIDC_ISSUER;
    else process.env.TURNKEY_GITHUB_OIDC_ISSUER = prevIssuer;
  });

  it("builds discovery pointing at mount JWKS", () => {
    delete process.env.TURNKEY_GITHUB_OIDC_ISSUER;
    const discovery = buildTurnkeyGithubOpenIdConfiguration();
    const issuer = getTurnkeyGithubOidcIssuer();
    assert.ok(issuer.endsWith(TURNKEY_GITHUB_OIDC_MOUNT));
    assert.equal(discovery.issuer, issuer);
    assert.equal(discovery.jwks_uri, `${issuer}/jwks`);
    assert.deepEqual(discovery.id_token_signing_alg_values_supported, ["RS256"]);
  });

  it("honors TURNKEY_GITHUB_OIDC_ISSUER override", async () => {
    process.env.TURNKEY_GITHUB_OIDC_ISSUER =
      "https://oidc.example.com/api/v1/turnkey-github-oidc/";
    assert.equal(
      getTurnkeyGithubOidcIssuer(),
      "https://oidc.example.com/api/v1/turnkey-github-oidc",
    );
    const { getTurnkeyGithubOidcJwksUrl } = await import(
      "@/lib/turnkey-github-oidc"
    );
    assert.equal(
      getTurnkeyGithubOidcJwksUrl(),
      "https://oidc.example.com/api/v1/turnkey-github-oidc/jwks",
    );
  });
});

describe("mintTurnkeyGithubOidcToken", () => {
  it("issues a verifiable RS256 id token with nonce binding", async (t) => {
    // Uses DB-backed signing keys when a real DATABASE_URL is available.
    if (
      process.env.PYMTHOUSE_TEST_DATABASE_URL_UNSET === "1" ||
      !process.env.DATABASE_URL?.trim()
    ) {
      t.skip("DATABASE_URL unset for this job");
      return;
    }

    const publicKey =
      "0394e549c71fa99dd5cf752fba623090be314949b74e4cdf7ca72031dd638e281a";
    const nonce = turnkeyOauthNonceFromPublicKey(publicKey);
    const token = await mintTurnkeyGithubOidcToken({
      githubUserId: 4242,
      nonce,
      email: "dev@example.com",
      name: "Dev",
      login: "dev",
    });

    const issuer = getTurnkeyGithubOidcIssuer();
    // Local verify via jose with exported JWK set from mint path would need JWKS;
    // decode claims without verify for shape, then verify with ensureSigningKey path.
    const { ensureSigningKey } = await import("@/lib/oidc/jwks");
    const key = await ensureSigningKey();
    const { payload } = await jose.jwtVerify(token, key.publicKey, {
      issuer,
      audience: TURNKEY_GITHUB_OIDC_AUDIENCE,
    });
    assert.equal(payload.sub, "github:4242");
    assert.equal(payload.nonce, nonce);
    assert.equal(payload.email, "dev@example.com");
  });
});
