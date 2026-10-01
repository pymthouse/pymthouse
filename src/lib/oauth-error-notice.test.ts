import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  completeOauthErrorNoticePost,
  normalizeNoticeEmail,
  oauthErrorNoticeAutoPostHtml,
  oauthErrorNoticeAutoPostResponse,
  OAUTH_ERROR_NOTICE_COOKIE,
  OAUTH_ERROR_NOTICE_POST_PATH,
  openOauthErrorNotice,
  sealOauthErrorNotice,
} from "@/lib/oauth-error-notice";
import { GITHUB_ACCOUNT_EXISTS_ERROR } from "@/lib/turnkey-github-auth";

describe("oauth error notice", () => {
  it("round-trips a signed GitHub-exists notice", () => {
    const sealed = sealOauthErrorNotice({
      error: GITHUB_ACCOUNT_EXISTS_ERROR,
      email: "you@example.com",
      intent: "login",
    });
    const opened = openOauthErrorNotice(sealed);
    assert.equal(opened?.email, "you@example.com");
    assert.equal(opened?.error, GITHUB_ACCOUNT_EXISTS_ERROR);
    assert.equal(opened?.intent, "login");
  });

  it("rejects a tampered payload", () => {
    const sealed = sealOauthErrorNotice({
      error: GITHUB_ACCOUNT_EXISTS_ERROR,
      email: "you@example.com",
      intent: "login",
    });
    assert.equal(openOauthErrorNotice(`${sealed}x`), null);
    assert.equal(openOauthErrorNotice("not-a-notice"), null);
  });

  it("posts the signed notice without putting email in a URL", () => {
    const sealed = sealOauthErrorNotice({
      error: GITHUB_ACCOUNT_EXISTS_ERROR,
      email: "you@example.com",
      intent: "link",
    });
    const html = oauthErrorNoticeAutoPostHtml(sealed);
    assert.match(html, /method="POST"/i);
    assert.match(html, new RegExp(`action="${OAUTH_ERROR_NOTICE_POST_PATH}"`));
    assert.equal(html.includes("email="), false);
    assert.equal(html.includes("you@example.com"), false);

    const formResponse = oauthErrorNoticeAutoPostResponse({
      error: GITHUB_ACCOUNT_EXISTS_ERROR,
      email: "you@example.com",
      intent: "link",
    });
    assert.equal(formResponse.status, 200);
    assert.equal(formResponse.headers.get("content-type"), "text/html; charset=utf-8");

    const response = completeOauthErrorNoticePost(sealed);
    assert.equal(response.status, 303);
    const location = response.headers.get("location") ?? "";
    assert.match(location, /\/account\?error=GitHubAccountExists$/);
    assert.equal(location.includes("email="), false);
    assert.equal(location.includes("you@example.com"), false);
    const cookie = response.cookies.get(OAUTH_ERROR_NOTICE_COOKIE);
    assert.equal(openOauthErrorNotice(cookie?.value)?.email, "you@example.com");
  });

  it("normalizes notice emails", () => {
    assert.equal(normalizeNoticeEmail("  you@example.com  "), "you@example.com");
    assert.equal(normalizeNoticeEmail("not-an-email"), null);
    assert.equal(normalizeNoticeEmail("a@b.com<script>"), null);
  });
});
