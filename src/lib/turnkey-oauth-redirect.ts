import { safeCallbackUrl } from "@/lib/turnkey-nextauth-bridge";

export const TURNKEY_OAUTH_CALLBACK_PATH = "/auth/callback";
export const TURNKEY_OAUTH_REDIRECT_STORAGE_KEY =
  "pymthouse.turnkeyOauthRedirect";
/** Drop a start-time pending flag that never saw a provider return. */
export const TURNKEY_OAUTH_REDIRECT_TTL_MS = 10 * 60 * 1000;

const TURNKEY_OAUTH_PROVIDERS = new Set([
  "google",
  "apple",
  "facebook",
  "discord",
  "x",
  "twitter",
]);

export type TurnkeyOauthRedirectState = {
  callbackUrl: string;
  resumeToken: string;
  startedAt: number;
};

/** React Strict Mode remounts must reuse the first consume, not hit empty storage. */
let consumedOauthRedirect: TurnkeyOauthRedirectState | null | undefined;

function createOauthResumeToken(): string {
  return crypto.randomUUID();
}

export function turnkeyOauthOpenInPageParams(callbackUrl: string): {
  openInPage: true;
  additionalState: { callbackUrl: string; resume: string };
} {
  const safeUrl = safeCallbackUrl(callbackUrl);
  const resume = createOauthResumeToken();
  storeTurnkeyOauthRedirect({
    callbackUrl: safeUrl,
    resumeToken: resume,
  });
  return {
    openInPage: true,
    additionalState: {
      callbackUrl: safeUrl,
      resume,
    },
  };
}

export function parseTurnkeyOauthRedirect(
  raw: string | null | undefined,
): TurnkeyOauthRedirectState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      callbackUrl?: unknown;
      resumeToken?: unknown;
      startedAt?: unknown;
    };
    if (typeof parsed.callbackUrl !== "string") return null;
    if (typeof parsed.resumeToken !== "string" || !parsed.resumeToken.trim()) {
      return null;
    }
    if (typeof parsed.startedAt !== "number" || !Number.isFinite(parsed.startedAt)) {
      return null;
    }
    return {
      callbackUrl: safeCallbackUrl(parsed.callbackUrl),
      resumeToken: parsed.resumeToken.trim(),
      startedAt: parsed.startedAt,
    };
  } catch {
    return null;
  }
}

function isFreshRedirect(state: TurnkeyOauthRedirectState, nowMs: number): boolean {
  const ageMs = nowMs - state.startedAt;
  return ageMs >= -60_000 && ageMs <= TURNKEY_OAUTH_REDIRECT_TTL_MS;
}

/** Persist post-login path and resume CSRF across the same-tab redirect. */
export function storeTurnkeyOauthRedirect(input: {
  callbackUrl: string;
  resumeToken: string;
  startedAt?: number;
}): void {
  try {
    const payload: TurnkeyOauthRedirectState = {
      callbackUrl: safeCallbackUrl(input.callbackUrl),
      resumeToken: input.resumeToken.trim(),
      startedAt: input.startedAt ?? Date.now(),
    };
    if (!payload.resumeToken) return;
    sessionStorage.setItem(
      TURNKEY_OAUTH_REDIRECT_STORAGE_KEY,
      JSON.stringify(payload),
    );
    consumedOauthRedirect = undefined;
  } catch {
    /* private mode / blocked storage — /auth/callback still completes */
  }
}

export function clearTurnkeyOauthRedirect(): void {
  consumedOauthRedirect = undefined;
  try {
    sessionStorage.removeItem(TURNKEY_OAUTH_REDIRECT_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function peekTurnkeyOauthRedirect(
  nowMs: number = Date.now(),
): TurnkeyOauthRedirectState | null {
  try {
    const raw = sessionStorage.getItem(TURNKEY_OAUTH_REDIRECT_STORAGE_KEY);
    const parsed = parseTurnkeyOauthRedirect(raw);
    if (!parsed || !isFreshRedirect(parsed, nowMs)) {
      if (raw) sessionStorage.removeItem(TURNKEY_OAUTH_REDIRECT_STORAGE_KEY);
      return null;
    }
    return parsed;
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

export function parseOauthStatePairs(
  state: string | null | undefined,
): Record<string, string> {
  if (!state) return {};
  const result: Record<string, string> = {};
  for (const pair of state.split("&")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    try {
      const key = decodeURIComponent(pair.slice(0, eq));
      const value = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, " "));
      if (key) result[key] = value;
    } catch {
      /* skip malformed pair */
    }
  }
  return result;
}

/** Wallet Kit redirect state always includes provider, flow=redirect, publicKey. */
export function isTurnkeyWalletKitRedirectState(
  state: string | null | undefined,
): boolean {
  const parsed = parseOauthStatePairs(state);
  return (
    TURNKEY_OAUTH_PROVIDERS.has(parsed.provider ?? "") &&
    parsed.flow === "redirect" &&
    Boolean(parsed.publicKey?.trim())
  );
}

export type TurnkeyOauthUrlReturn = {
  kind: "success" | "error";
  state: string;
  resumeToken: string | null;
};

/**
 * Extract a Wallet Kit same-tab OAuth return from the current URL.
 * Google/Apple put id_token in the hash; Discord/X/Facebook put code in search.
 * Random hashes and generic OIDC `code`+`state` pairs are ignored.
 */
export function extractTurnkeyOauthUrlReturn(
  href: string,
): TurnkeyOauthUrlReturn | null {
  try {
    const url = new URL(href, "https://pymthouse.local");
    const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
    let idToken: string | null = null;
    let code = url.searchParams.get("code");
    let error =
      url.searchParams.get("error") || url.searchParams.get("error_description");
    let state = url.searchParams.get("state");

    if (hash.startsWith("state=provider=apple")) {
      idToken = hash.match(/(?:^|&)id_token=([^&]+)/)?.[1] ?? null;
      const stateEnd = hash.search(/&(?:code|id_token)=/);
      state =
        stateEnd === -1
          ? hash.slice("state=".length)
          : hash.slice("state=".length, stateEnd);
      error ||= new URLSearchParams(hash).get("error");
    } else if (hash) {
      const hashParams = new URLSearchParams(hash);
      idToken = hashParams.get("id_token");
      state ||= hashParams.get("state");
      error ||= hashParams.get("error");
      code ||= hashParams.get("code");
    }

    if (!isTurnkeyWalletKitRedirectState(state)) return null;
    const resumeToken = parseOauthStatePairs(state).resume?.trim() || null;
    if (error) return { kind: "error", state: state!, resumeToken };
    if (idToken || code) return { kind: "success", state: state!, resumeToken };
    return null;
  } catch {
    return null;
  }
}

/** True when the URL is a successful Wallet Kit OAuth provider return. */
export function hasTurnkeyOauthReturnParams(href: string): boolean {
  return extractTurnkeyOauthUrlReturn(href)?.kind === "success";
}

export function hasTurnkeyOauthErrorReturn(href: string): boolean {
  return extractTurnkeyOauthUrlReturn(href)?.kind === "error";
}

function returnMatchesPending(
  href: string,
  pending: TurnkeyOauthRedirectState,
): boolean {
  const extracted = extractTurnkeyOauthUrlReturn(href);
  if (extracted?.kind !== "success") return false;
  return extracted.resumeToken === pending.resumeToken;
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
 * so NextAuth can be bridged. Requires the provider return in the URL and a
 * resume token that matches the value written at OAuth start for this tab.
 */
export function shouldResumeTurnkeyOauthCallback(input: {
  pathname: string;
  href: string;
  pending: TurnkeyOauthRedirectState | null;
  turnkeyAuthenticated: boolean;
  nextAuthAuthenticated: boolean;
}): boolean {
  if (!input.pending) return false;
  if (!input.turnkeyAuthenticated) return false;
  if (input.nextAuthAuthenticated) return false;
  if (isTurnkeyOauthCallbackPath(input.pathname)) return false;
  return returnMatchesPending(input.href, input.pending);
}
