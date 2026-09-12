import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import { getNextAuthSecret } from "@/lib/next-auth-secret";
import { getPublicOrigin } from "@/lib/oidc/issuer-urls";
import { GITHUB_ACCOUNT_EXISTS_ERROR } from "@/lib/turnkey-github-auth";
import {
  type GithubOauthIntent,
  githubAuthCookieOptions,
} from "@/lib/turnkey-github-cookies";

const NOTICE_MAX_AGE_MS = 2 * 60 * 1000;

export const OAUTH_ERROR_NOTICE_COOKIE = "pmth_oauth_error_notice";
export const OAUTH_ERROR_NOTICE_POST_PATH = "/api/auth/oauth-error";

export type OauthErrorNotice = {
  error: string;
  email: string;
  intent: GithubOauthIntent;
  exp: number;
};

function signingSecret(): string {
  const secret = getNextAuthSecret({ suppressDevWarning: true });
  if (!secret) {
    throw new Error("NEXTAUTH_SECRET is required for OAuth error notices");
  }
  return secret;
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64url");
}

function signPayload(encodedBody: string): string {
  // HMAC-SHA256 authenticates the OAuth error notice (integrity MAC), not password hashing.
  // codeql[js/insufficient-password-hash]
  return createHmac("sha256", signingSecret())
    .update(encodedBody)
    .digest("base64url");
}

export function normalizeNoticeEmail(email: string): string | null {
  const trimmed = email.trim();
  if (!trimmed || trimmed.length > 254) return null;
  if (/[\s<>"'\\]/.test(trimmed)) return null;
  if (!trimmed.includes("@")) return null;
  return trimmed;
}

export function sealOauthErrorNotice(
  input: Omit<OauthErrorNotice, "exp"> & { exp?: number },
): string {
  const email = normalizeNoticeEmail(input.email);
  if (!email) {
    throw new Error("OAuth error notice requires a valid email");
  }
  if (input.error !== GITHUB_ACCOUNT_EXISTS_ERROR) {
    throw new Error("OAuth error notice is only for GitHubAccountExists");
  }
  const body: OauthErrorNotice = {
    error: GITHUB_ACCOUNT_EXISTS_ERROR,
    email,
    intent: input.intent === "link" ? "link" : "login",
    exp: input.exp ?? Date.now() + NOTICE_MAX_AGE_MS,
  };
  const encodedBody = b64urlEncode(Buffer.from(JSON.stringify(body), "utf8"));
  return `${encodedBody}.${signPayload(encodedBody)}`;
}

export function openOauthErrorNotice(
  sealed: string | null | undefined,
): OauthErrorNotice | null {
  if (!sealed) return null;
  const parts = sealed.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [encodedBody, sig] = parts;
  const expected = signPayload(encodedBody);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(encodedBody, "base64url").toString("utf8"),
    );
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    if (
      obj.error !== GITHUB_ACCOUNT_EXISTS_ERROR ||
      typeof obj.email !== "string" ||
      typeof obj.exp !== "number"
    ) {
      return null;
    }
    if (obj.exp < Date.now()) return null;
    const email = normalizeNoticeEmail(obj.email);
    if (!email) return null;
    return {
      error: GITHUB_ACCOUNT_EXISTS_ERROR,
      email,
      intent: obj.intent === "link" ? "link" : "login",
      exp: obj.exp,
    };
  } catch {
    return null;
  }
}

function escapeHtmlAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function oauthErrorNoticeAutoPostHtml(sealed: string): string {
  const action = escapeHtmlAttr(OAUTH_ERROR_NOTICE_POST_PATH);
  const notice = escapeHtmlAttr(sealed);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="robots" content="noindex" />
  <title>Continue sign-in</title>
</head>
<body>
  <form id="oauth-error-notice" method="POST" action="${action}">
    <input type="hidden" name="notice" value="${notice}" />
    <noscript><button type="submit">Continue</button></noscript>
  </form>
  <script>document.getElementById("oauth-error-notice").submit();</script>
</body>
</html>`;
}

export function oauthErrorNoticeAutoPostResponse(input: {
  error: string;
  email: string;
  intent: GithubOauthIntent;
}): NextResponse {
  const html = oauthErrorNoticeAutoPostHtml(sealOauthErrorNotice(input));
  return new NextResponse(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export function completeOauthErrorNoticePost(
  sealed: string,
): NextResponse {
  const notice = openOauthErrorNotice(sealed);
  const intent: GithubOauthIntent = notice?.intent === "link" ? "link" : "login";
  const path = intent === "link" ? "/account" : "/login";
  const url = new URL(path, getPublicOrigin());
  if (!notice) {
    url.searchParams.set("error", "InvalidOauthState");
    return NextResponse.redirect(url, 303);
  }
  url.searchParams.set("error", notice.error);
  const response = NextResponse.redirect(url, 303);
  response.cookies.set(
    OAUTH_ERROR_NOTICE_COOKIE,
    sealed,
    githubAuthCookieOptions(Math.floor(NOTICE_MAX_AGE_MS / 1000)),
  );
  return response;
}
