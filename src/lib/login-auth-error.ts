import {
  OAUTH_ACCOUNT_EXISTS_ERROR,
  isTurnkeyAccountAlreadyExistsError,
  oauthAccountExistsMessage,
} from "@/lib/turnkey-account-exists";

/** Map NextAuth / GitHub OAuth `?error=` codes to login-page copy. */
export function loginAuthErrorMessage(
  authError: string | null,
  email?: string | null,
  provider?: string | null,
): string | null {
  if (!authError) return null;
  if (
    authError.includes(OAUTH_ACCOUNT_EXISTS_ERROR) ||
    isTurnkeyAccountAlreadyExistsError(authError)
  ) {
    return oauthAccountExistsMessage(provider);
  }
  if (authError.includes("AccessDenied")) {
    return "Sign-in was denied. You can try again or use a different sign-in method.";
  }
  if (authError.includes("GitHubLoginNotConfigured")) {
    return "GitHub sign-in is not configured for this environment.";
  }
  if (authError.includes("GitHubAccountExists")) {
    const shown = email?.trim();
    if (shown) {
      return `An account already exists for ${shown}. Sign in with Google or email, then add GitHub from your account settings.`;
    }
    return "An account already exists for this email. Sign in with Google or email, then add GitHub from your account settings.";
  }
  if (authError.includes("GitHubTurnkeyLoginFailed")) {
    return "GitHub sign-in could not create a wallet session. Please try again.";
  }
  if (
    authError.includes("InvalidOauthState") ||
    authError.includes("InvalidGithubCallback") ||
    authError.includes("InvalidPublicKey")
  ) {
    return "GitHub sign-in expired or was invalid. Please try again.";
  }
  return "Sign-in failed. Please try again.";
}
