"use client";

import { AuthState, ClientState, useTurnkey } from "@turnkey/react-wallet-kit";
import { useSession } from "next-auth/react";
import { useEffect, useLayoutEffect, useRef } from "react";
import {
  clearTurnkeyOauthRedirect,
  hasTurnkeyOauthErrorReturn,
  oauthCallbackResumeUrl,
  peekTurnkeyOauthRedirect,
  shouldResumeTurnkeyOauthCallback,
} from "@/lib/turnkey-oauth-redirect";

/**
 * After Google/Discord same-tab OAuth, Wallet Kit may land on the configured
 * redirect URI (often the origin). Send Authenticated returns to /auth/callback
 * so NextAuth can be bridged — /login would treat the session as leftover.
 *
 * Snapshot href in layout before Wallet Kit strips the hash. Resume only when
 * the URL is a Wallet Kit success return whose `resume` state matches the
 * token written at OAuth start for this tab.
 */
export function TurnkeyOauthRedirectResume() {
  const { authState, clientState } = useTurnkey();
  const { status } = useSession();
  const oauthReturnHref = useRef("");

  useLayoutEffect(() => {
    oauthReturnHref.current = window.location.href;
  }, []);

  useEffect(() => {
    if (clientState !== ClientState.Ready) return;
    const href = oauthReturnHref.current || window.location.href;
    if (hasTurnkeyOauthErrorReturn(href)) {
      clearTurnkeyOauthRedirect();
      return;
    }
    let cancelled = false;
    void (async () => {
      const pending = peekTurnkeyOauthRedirect();
      if (
        !pending ||
        !(await shouldResumeTurnkeyOauthCallback({
          pathname: window.location.pathname,
          href,
          pending,
          turnkeyAuthenticated: authState === AuthState.Authenticated,
          nextAuthAuthenticated: status === "authenticated",
        }))
      ) {
        return;
      }
      if (cancelled) return;
      window.location.replace(oauthCallbackResumeUrl(pending.callbackUrl));
    })();
    return () => {
      cancelled = true;
    };
  }, [authState, clientState, status]);

  return null;
}
