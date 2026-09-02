import { safeCallbackUrl } from "@/lib/turnkey-nextauth-bridge";

export const TURNKEY_OAUTH_CALLBACK_PATH = "/auth/callback";
export const TURNKEY_OAUTH_REDIRECT_STORAGE_KEY =
  "pymthouse.turnkeyOauthRedirect";

export type TurnkeyOauthRedirectState = {
  callbackUrl: string;
};

/** React Strict Mode remounts must reuse the first consume, not hit empty storage. */
let consumedOauthRedirect: TurnkeyOauthRedirectState | null | undefined;

export function turnkeyOauthOpenInPageParams(callbackUrl: string): {
  openInPage: true;
  additionalState: { callbackUrl: string };
} {
  return {
    openInPage: true,
    additionalState: {
      callbackUrl: safeCallbackUrl(callbackUrl),
    },
  };
}

export function parseTurnkeyOauthRedirect(
  raw: string | null | undefined,
): TurnkeyOauthRedirectState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { callbackUrl?: unknown };
    if (typeof parsed.callbackUrl !== "string") return null;
    return { callbackUrl: safeCallbackUrl(parsed.callbackUrl) };
  } catch {
    return null;
  }
}

/** Persist post-login path across the Google/Discord same-tab redirect. */
export function storeTurnkeyOauthRedirect(input: {
  callbackUrl: string;
}): void {
  try {
    const payload: TurnkeyOauthRedirectState = {
      callbackUrl: safeCallbackUrl(input.callbackUrl),
    };
    sessionStorage.setItem(
      TURNKEY_OAUTH_REDIRECT_STORAGE_KEY,
      JSON.stringify(payload),
    );
    consumedOauthRedirect = undefined;
  } catch {
    /* private mode / blocked storage — /auth/callback still completes */
  }
}

export function peekTurnkeyOauthRedirect(): TurnkeyOauthRedirectState | null {
  try {
    return parseTurnkeyOauthRedirect(
      sessionStorage.getItem(TURNKEY_OAUTH_REDIRECT_STORAGE_KEY),
    );
  } catch {
    return null;
  }
}

export function consumeTurnkeyOauthRedirect(): TurnkeyOauthRedirectState | null {
  const value = peekTurnkeyOauthRedirect();
  try {
    sessionStorage.removeItem(TURNKEY_OAUTH_REDIRECT_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  return value;
}

export function takeTurnkeyOauthRedirectOnce(): TurnkeyOauthRedirectState | null {
  if (consumedOauthRedirect !== undefined) return consumedOauthRedirect;
  consumedOauthRedirect = consumeTurnkeyOauthRedirect();
  return consumedOauthRedirect;
}

/** True when the current URL looks like a Wallet Kit OAuth provider return. */
export function hasTurnkeyOauthReturnParams(href: string): boolean {
  try {
    const url = new URL(href, "https://pymthouse.local");
    if (url.hash.length > 1) return true;
    return url.searchParams.has("code") && url.searchParams.has("state");
  } catch {
    return false;
  }
}

export function isTurnkeyOauthCallbackPath(pathname: string): boolean {
  return pathname === TURNKEY_OAUTH_CALLBACK_PATH;
}

export function oauthCallbackResumeUrl(callbackUrl: string): string {
  const url = new URL(TURNKEY_OAUTH_CALLBACK_PATH, "https://pymthouse.local");
  url.searchParams.set("callbackUrl", safeCallbackUrl(callbackUrl));
  return `${url.pathname}${url.search}`;
}

/**
 * After a same-tab Google/Discord return, send the user to /auth/callback
 * so NextAuth can be bridged. /login would otherwise treat the fresh
 * Turnkey session as leftover and log it out.
 */
export function shouldResumeTurnkeyOauthCallback(input: {
  pathname: string;
  hasPendingRedirect: boolean;
  turnkeyAuthenticated: boolean;
  nextAuthAuthenticated: boolean;
  sawOauthReturnParams: boolean;
}): boolean {
  if (!input.hasPendingRedirect) return false;
  if (!input.sawOauthReturnParams) return false;
  if (input.nextAuthAuthenticated) return false;
  if (!input.turnkeyAuthenticated) return false;
  if (isTurnkeyOauthCallbackPath(input.pathname)) return false;
  return true;
}
