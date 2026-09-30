import {
  OAUTH_ACCOUNT_EXISTS_ERROR,
  isTurnkeyAccountAlreadyExistsError,
  oauthAccountExistsMessage,
} from "@/lib/turnkey-account-exists";

function unknownErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "";
}

/**
 * Google/Discord Auth Proxy resolved a verified-email leftover that has no
 * OAuth public key. Email OTP still opens that same sub-org.
 */
export function isUnreachableOauthSubOrgError(error: unknown): boolean {
  const message = unknownErrorText(error);
  return (
    /PUBLIC_KEY_NOT_FOUND/i.test(message) ||
    /no user found for attested identity/i.test(message)
  );
}

export const OAUTH_SUBORG_RECOVERY_MESSAGE =
  "Google can't open this wallet. Enter the same email below — the code opens the older login so you can add Google or delete it.";

/** Map NextAuth / GitHub OAuth `?error=` codes to login-page copy. */
export function loginAuthErrorMessage(
  authError: string | null,
  email?: string | null,
  provider?: string | null,
): string | null {
  if (!authError) return null;
  if (isUnreachableOauthSubOrgError(authError)) {
    return OAUTH_SUBORG_RECOVERY_MESSAGE;
  }
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
