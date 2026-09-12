import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isUnreachableOauthSubOrgError,
  loginAuthErrorMessage,
} from "@/lib/login-auth-error";

describe("loginAuthErrorMessage", () => {
  it("returns null when there is no error", () => {
    assert.equal(loginAuthErrorMessage(null), null);
  });

  it("explains a GitHub account that already exists by verified email", () => {
    assert.equal(
      loginAuthErrorMessage("GitHubAccountExists", "you@example.com"),
      "An account already exists for you@example.com. Sign in with Google or email, then add GitHub from your account settings.",
    );
    const fallback = loginAuthErrorMessage("GitHubAccountExists");
    assert.ok(fallback);
    assert.match(fallback, /An account already exists for this email/);
  });

  it("explains an OIDC identity that already belongs to another wallet", () => {
    assert.match(
      loginAuthErrorMessage("OauthAccountExists", null, "discord") ?? "",
      /Discord already opens a different wallet/,
    );
    assert.match(
      loginAuthErrorMessage(
        "Account already exists with this OIDC token or claims",
      ) ?? "",
      /already opens a different wallet/,
    );
  });

  it("keeps the existing GitHub and generic mappings", () => {
    const notConfigured = loginAuthErrorMessage("GitHubLoginNotConfigured");
    const failed = loginAuthErrorMessage("GitHubTurnkeyLoginFailed");
    const invalid = loginAuthErrorMessage("InvalidOauthState");
    const denied = loginAuthErrorMessage("AccessDenied");
    const generic = loginAuthErrorMessage("SomethingElse");
    assert.ok(notConfigured);
    assert.ok(failed);
    assert.ok(invalid);
    assert.ok(denied);
    assert.ok(generic);
    assert.match(notConfigured, /not configured/);
    assert.match(failed, /could not create a wallet session/);
    assert.match(invalid, /expired or was invalid/);
    assert.match(denied, /denied/);
    assert.match(generic, /Sign-in failed/);
  });

  it("directs leftover Google failures to email OTP", () => {
    assert.match(
      loginAuthErrorMessage(
        "Turnkey error 16 PUBLIC_KEY_NOT_FOUND no user found for attested identity",
      ) ?? "",
      /Enter the same email below/,
    );
  });
});

describe("isUnreachableOauthSubOrgError", () => {
  it("matches the attested-stamp leftover", () => {
    assert.equal(
      isUnreachableOauthSubOrgError(
        new Error("PUBLIC_KEY_NOT_FOUND: no user found for attested identity"),
      ),
      true,
    );
    assert.equal(isUnreachableOauthSubOrgError("AccessDenied"), false);
  });
});
