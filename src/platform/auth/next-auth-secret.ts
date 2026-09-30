const DISALLOWED_DEV_SECRETS = new Set([
  "generate-a-random-secret-here",
  "replace-with-random-base64-secret",
  "dev-secret-change-me",
  "changeme",
  "change-me",
]);

let hasWarnedInvalidSecret = false;

function isLikelyPlaceholder(secret: string): boolean {
  const normalized = secret.trim().toLowerCase();
  if (!normalized) return true;
  if (DISALLOWED_DEV_SECRETS.has(normalized)) return true;
  return normalized.includes("random-secret") || normalized.includes("changeme");
}

export function getNextAuthSecret(opts?: {
  suppressDevWarning?: boolean;
}): string | undefined {
  const raw = process.env.NEXTAUTH_SECRET;
  const secret = typeof raw === "string" ? raw.trim() : "";
  const missingSecret = !secret;
  const placeholderSecret = !missingSecret && isLikelyPlaceholder(secret);

  if (!missingSecret && !placeholderSecret) return secret;

  const message =
    "[auth] NEXTAUTH_SECRET is missing or looks like a placeholder. " +
    "Set one stable value (for example: `openssl rand -base64 32`) and avoid " +
    "conflicting values between .env and .env.local.";

  if (process.env.NODE_ENV === "production") {
    throw new Error(message);
  }

  if (!opts?.suppressDevWarning && !hasWarnedInvalidSecret) {
    console.error(message);
    hasWarnedInvalidSecret = true;
  }

  return missingSecret ? undefined : secret;
}
