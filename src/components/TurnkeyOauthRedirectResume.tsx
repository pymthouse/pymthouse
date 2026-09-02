"use client";

import { AuthState, ClientState, useTurnkey } from "@turnkey/react-wallet-kit";
import { useSession } from "next-auth/react";
import { useEffect, useLayoutEffect, useRef } from "react";
import {
  hasTurnkeyOauthReturnParams,
  oauthCallbackResumeUrl,
  peekTurnkeyOauthRedirect,
  shouldResumeTurnkeyOauthCallback,
} from "@/lib/turnkey-oauth-redirect";

/**
 * After Google/Discord same-tab OAuth, Wallet Kit may land on the configured
 * redirect URI (often the origin). Send Authenticated returns to /auth/callback
 * so NextAuth can be bridged — /login would treat the session as leftover.
 */
export function TurnkeyOauthRedirectResume() {
  const { authState, clientState } = useTurnkey();
  const { status } = useSession();
  const sawOauthReturnParams = useRef(false);

  useLayoutEffect(() => {
    sawOauthReturnParams.current = hasTurnkeyOauthReturnParams(
      window.location.href,
    );
  }, []);

  useEffect(() => {
    if (clientState !== ClientState.Ready) return;
    const pending = peekTurnkeyOauthRedirect();
    if (
      !pending ||
      !shouldResumeTurnkeyOauthCallback({
        pathname: window.location.pathname,
        hasPendingRedirect: true,
        turnkeyAuthenticated: authState === AuthState.Authenticated,
        nextAuthAuthenticated: status === "authenticated",
        sawOauthReturnParams: sawOauthReturnParams.current,
      })
    ) {
      return;
    }
    window.location.replace(oauthCallbackResumeUrl(pending.callbackUrl));
  }, [authState, clientState, status]);

  return null;
}
