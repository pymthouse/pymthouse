import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getNextAuthSecret } from "@/lib/next-auth-secret";
import { safeCallbackUrl } from "@/lib/turnkey-nextauth-bridge";

const STATE_MAX_AGE_MS = 10 * 60 * 1000;
const HANDOFF_MAX_AGE_SEC = 120;

export const GITHUB_OAUTH_STATE_COOKIE = "pmth_github_oauth_state";
export const GITHUB_SESSION_HANDOFF_COOKIE = "pmth_github_tk_session";

export type GithubOauthStatePayload = {
  publicKey: string;
  nonce: string;
  callbackUrl: string;
  csrf: string;
  exp: number;
};

function signingSecret(): string {
  const secret = getNextAuthSecret({ suppressDevWarning: true });
  if (!secret) {
    throw new Error("NEXTAUTH_SECRET is required for GitHub Turnkey login");
  }
  return secret;
}

function b64urlEncode(buf: Buffer): string {
  // Native base64url avoids regex padding-strip ReDoS (js/polynomial-redos).
  return buf.toString("base64url");
}

function b64urlDecode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function signPayload(encodedBody: string): string {
  // HMAC-SHA256 authenticates OAuth state (integrity MAC), not password hashing.
  // codeql[js/insufficient-password-hash]
  // lgtm[js/insufficient-password-hash]
  return createHmac("sha256", signingSecret())
    .update(encodedBody)
    .digest("base64url");
}

export function createGithubOauthCsrf(): string {
  return b64urlEncode(randomBytes(24));
}

export function sealGithubOauthState(
  payload: Omit<GithubOauthStatePayload, "exp"> & { exp?: number },
): string {
  const body: GithubOauthStatePayload = {
    publicKey: payload.publicKey,
    nonce: payload.nonce,
    callbackUrl: safeCallbackUrl(payload.callbackUrl),
    csrf: payload.csrf,
    exp: payload.exp ?? Date.now() + STATE_MAX_AGE_MS,
  };
  const encodedBody = b64urlEncode(Buffer.from(JSON.stringify(body), "utf8"));
  return `${encodedBody}.${signPayload(encodedBody)}`;
}

export function openGithubOauthState(
  sealed: string,
): GithubOauthStatePayload | null {
  const parts = sealed.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [encodedBody, sig] = parts;
  const expected = signPayload(encodedBody);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const parsed: unknown = JSON.parse(
      b64urlDecode(encodedBody).toString("utf8"),
    );
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    if (
      typeof obj.publicKey !== "string" ||
      typeof obj.nonce !== "string" ||
      typeof obj.callbackUrl !== "string" ||
      typeof obj.csrf !== "string" ||
      typeof obj.exp !== "number"
    ) {
      return null;
    }
    if (obj.exp < Date.now()) return null;
    return {
      publicKey: obj.publicKey,
      nonce: obj.nonce,
      callbackUrl: safeCallbackUrl(obj.callbackUrl),
      csrf: obj.csrf,
      exp: obj.exp,
    };
  } catch {
    return null;
  }
}

export function githubAuthCookieOptions(maxAgeSec: number): {
  httpOnly: boolean;
  sameSite: "lax";
  path: string;
  maxAge: number;
  secure: boolean;
} {
  const secure =
    process.env.NODE_ENV === "production" ||
    (process.env.NEXTAUTH_URL ?? "").startsWith("https:");
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeSec,
    secure,
  };
}

export function githubOauthStateCookieOptions() {
  return githubAuthCookieOptions(Math.floor(STATE_MAX_AGE_MS / 1000));
}

export function githubSessionHandoffCookieOptions() {
  return githubAuthCookieOptions(HANDOFF_MAX_AGE_SEC);
}

export function clearCookieOptions(): {
  httpOnly: boolean;
  sameSite: "lax";
  path: string;
  maxAge: number;
  secure: boolean;
} {
  return githubAuthCookieOptions(0);
}
