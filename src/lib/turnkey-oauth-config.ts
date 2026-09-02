import type { TurnkeyProviderConfig } from "@turnkey/react-wallet-kit";

function trimEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

/**
 * Wallet Kit OAuth config for /login social buttons.
 * Always open Google/Discord/Apple/X in the same tab (redirect), matching
 * GitHub's window.location.assign start. Chrome blocks the kit's default
 * popup because AuthComponent calls window.open after async work.
 */
export function buildTurnkeyWalletOauthAuthConfig(): NonNullable<
  TurnkeyProviderConfig["auth"]
> {
  const oauthRedirectUri =
    trimEnv(process.env.NEXT_PUBLIC_TURNKEY_OAUTH_REDIRECT_URI) ||
    trimEnv(process.env.NEXT_PUBLIC_OAUTH_REDIRECT_URI);
  const googleClientId = trimEnv(
    process.env.NEXT_PUBLIC_TURNKEY_GOOGLE_CLIENT_ID,
  );
  const appleClientId = trimEnv(process.env.NEXT_PUBLIC_TURNKEY_APPLE_CLIENT_ID);
  const discordClientId = trimEnv(
    process.env.NEXT_PUBLIC_TURNKEY_DISCORD_CLIENT_ID,
  );
  const xClientId = trimEnv(process.env.NEXT_PUBLIC_TURNKEY_X_CLIENT_ID);

  return {
    oauthConfig: {
      openOauthInPage: true,
      ...(oauthRedirectUri ? { oauthRedirectUri } : {}),
      ...(googleClientId ? { google: { primaryClientId: googleClientId } } : {}),
      ...(appleClientId ? { apple: { primaryClientId: appleClientId } } : {}),
      ...(discordClientId
        ? { discord: { primaryClientId: discordClientId } }
        : {}),
      ...(xClientId ? { x: { primaryClientId: xClientId } } : {}),
    },
  };
}
