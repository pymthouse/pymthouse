/** Wallet Kit / Turnkey when an OIDC identity already belongs to another sub-org. */
export const OAUTH_ACCOUNT_EXISTS_ERROR = "OauthAccountExists";

const ACCOUNT_EXISTS_MESSAGE =
  "Account already exists with this OIDC token or claims";

function providerLabel(provider: string | null | undefined): string {
  const raw = provider?.trim().toLowerCase();
  if (raw === "google") return "Google";
  if (raw === "github") return "GitHub";
  if (raw === "discord") return "Discord";
  if (raw === "apple") return "Apple";
  if (raw === "x" || raw === "twitter") return "X";
  return "This sign-in method";
}

export function isTurnkeyAccountAlreadyExistsError(error: unknown): boolean {
  if (error == null || typeof error !== "object") {
    return typeof error === "string" && error.includes(ACCOUNT_EXISTS_MESSAGE);
  }
  const code = "code" in error && typeof error.code === "string" ? error.code : "";
  const message =
    "message" in error && typeof error.message === "string" ? error.message : "";
  return (
    code === "ACCOUNT_ALREADY_EXISTS" || message.includes(ACCOUNT_EXISTS_MESSAGE)
  );
}

export function oauthAccountExistsMessage(
  provider?: string | null,
): string {
  return (
    `${providerLabel(provider)} already opens a different wallet. ` +
    "Sign in with that method to use it, or add an account that is not linked yet."
  );
}
