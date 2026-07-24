import { createHash } from "node:crypto";
import { normalizeUserCode } from "@/lib/oidc/device";

const INITIATE_SKIP_MAX_AGE_SEC = 120;

/**
 * HttpOnly cookie name: one skip flag per **client + device user code** so a
 * prior attempt (or logout / new CLI code) does not block third-party
 * `initiate_login_uri` redirects for unrelated flows for the same app.
 *
 * Kept in a server-only module so client components can import
 * `validateInitiateLoginUri` without pulling `node:crypto` into the webpack
 * client bundle.
 */
export function thirdPartyInitiateSkipCookieName(
  clientId: string,
  userCode?: string | null,
): string {
  const normalized = userCode?.trim()
    ? normalizeUserCode(userCode)
    : "";
  const h = createHash("sha256")
    .update(`${clientId}\0${normalized}`)
    .digest("hex")
    .slice(0, 16);
  return `pmth_tp_skip_${h}`;
}

export function initiateSkipCookieOptions(): {
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
    maxAge: INITIATE_SKIP_MAX_AGE_SEC,
    secure,
  };
}
