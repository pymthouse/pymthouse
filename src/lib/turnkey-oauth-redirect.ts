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
  resumeDigest: string;
  startedAt: number;
};

export type TurnkeyOauthStateFields = {
  provider: string;
  flow: string;
  publicKey: string;
  resume: string;
};

/** React Strict Mode remounts must reuse the first consume, not hit empty storage. */
let consumedOauthRedirect: TurnkeyOauthRedirectState | null | undefined;

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function turnkeyOauthOpenInPageParams(callbackUrl: string): Promise<{
  openInPage: true;
  additionalState: { callbackUrl: string; resume: string };
}> {
  const safeUrl = safeCallbackUrl(callbackUrl);
  const resume = crypto.randomUUID();
  storeTurnkeyOauthRedirect({
    callbackUrl: safeUrl,
    resumeDigest: await sha256Hex(resume),
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
      resumeDigest?: unknown;
      startedAt?: unknown;
    };
    if (typeof parsed.callbackUrl !== "string") return null;
    if (typeof parsed.resumeDigest !== "string" || !parsed.resumeDigest.trim()) {
      return null;
    }
    if (typeof parsed.startedAt !== "number" || !Number.isFinite(parsed.startedAt)) {
      return null;
    }
    return {
      callbackUrl: safeCallbackUrl(parsed.callbackUrl),
      resumeDigest: parsed.resumeDigest.trim(),
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
  resumeDigest: string;
  startedAt?: number;
}): void {
  try {
    const payload: TurnkeyOauthRedirectState = {
      callbackUrl: safeCallbackUrl(input.callbackUrl),
      resumeDigest: input.resumeDigest.trim(),
      startedAt: input.startedAt ?? Date.now(),
    };
    if (!payload.resumeDigest) return;
    // Same-tab CSRF binder: SHA-256 digest of the Wallet Kit `resume` state
    // value, not a credential. sessionStorage is required across the IdP hop.
    sessionStorage.setItem( // lgtm[js/clear-text-storage-of-sensitive-data]
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
): TurnkeyOauthStateFields {
  const parsed: TurnkeyOauthStateFields = {
    provider: "",
    flow: "",
    publicKey: "",
    resume: "",
  };
  if (!state) return parsed;
  for (const pair of state.split("&")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent(pair.slice(0, eq));
      value = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, " "));
    } catch {
      continue;
    }
    switch (key) {
      case "provider":
        parsed.provider = value;
        break;
      case "flow":
        parsed.flow = value;
        break;
      case "publicKey":
        parsed.publicKey = value;
        break;
      case "resume":
        parsed.resume = value;
        break;
      default:
        break;
    }
  }
  return parsed;
}

/** Wallet Kit redirect state always includes provider, flow=redirect, publicKey. */
export function isTurnkeyWalletKitRedirectState(
  state: string | null | undefined,
): boolean {
  const parsed = parseOauthStatePairs(state);
  return (
    TURNKEY_OAUTH_PROVIDERS.has(parsed.provider) &&
    parsed.flow === "redirect" &&
    Boolean(parsed.publicKey.trim())
  );
}

export type TurnkeyOauthUrlReturn = {
  kind: "success" | "error";
  state: string;
  resume: string | null;
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
      idToken = /(?:^|&)id_token=([^&]+)/.exec(hash)?.[1] ?? null;
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

    if (!state || !isTurnkeyWalletKitRedirectState(state)) return null;
    const resume = parseOauthStatePairs(state).resume.trim() || null;
    if (error) return { kind: "error", state, resume };
    if (idToken || code) return { kind: "success", state, resume };
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

async function returnMatchesPending(
  href: string,
  pending: TurnkeyOauthRedirectState,
): Promise<boolean> {
  const extracted = extractTurnkeyOauthUrlReturn(href);
  if (extracted?.kind !== "success" || !extracted.resume) return false;
  return (await sha256Hex(extracted.resume)) === pending.resumeDigest;
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
 * resume digest that matches the value written at OAuth start for this tab.
 */
export async function shouldResumeTurnkeyOauthCallback(input: {
  pathname: string;
  href: string;
  pending: TurnkeyOauthRedirectState | null;
  turnkeyAuthenticated: boolean;
  nextAuthAuthenticated: boolean;
}): Promise<boolean> {
  if (!input.pending) return false;
  if (!input.turnkeyAuthenticated) return false;
  if (input.nextAuthAuthenticated) return false;
  if (isTurnkeyOauthCallbackPath(input.pathname)) return false;
  return returnMatchesPending(input.href, input.pending);
}
