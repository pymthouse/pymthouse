import { createRemoteJWKSet, jwtVerify } from "jose";
import { getPublicOrigin } from "@/lib/oidc/issuer-urls";

const GOOGLE_JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
);

function trimEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export const GOOGLE_OAUTH_STATE_COOKIE = "pmth_google_oauth_state";

export function getGoogleOAuthClientId(): string | undefined {
  return trimEnv(process.env.GOOGLE_CLIENT_ID);
}

export function getGoogleOAuthClientSecret(): string | undefined {
  return trimEnv(process.env.GOOGLE_CLIENT_SECRET);
}

export function isGoogleWalletLoginConfigured(): boolean {
  return Boolean(getGoogleOAuthClientId() && getGoogleOAuthClientSecret());
}

export function googleOAuthCallbackUrl(): string {
  return `${getPublicOrigin()}/api/auth/google/callback`;
}

export function googleAuthorizeUrl(input: {
  state: string;
  clientId: string;
  nonce: string;
}): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", googleOAuthCallbackUrl());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

export async function exchangeGoogleOAuthCode(
  code: string,
): Promise<{ idToken: string }> {
  const clientId = getGoogleOAuthClientId();
  const clientSecret = getGoogleOAuthClientSecret();
  if (!clientId || !clientSecret) throw new Error("Google OAuth is not configured");
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: googleOAuthCallbackUrl(),
    grant_type: "authorization_code",
  });
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!tokenRes.ok) throw new Error(`Google token exchange failed (${tokenRes.status})`);
  const json = (await tokenRes.json()) as { id_token?: string };
  if (!json.id_token) throw new Error("Google token exchange returned no id_token");
  return { idToken: json.id_token };
}

export async function verifyGoogleIdToken(input: {
  idToken: string;
  nonce: string;
}): Promise<{ email: string; name: string | null }> {
  const clientId = getGoogleOAuthClientId();
  if (!clientId) throw new Error("Google OAuth is not configured");
  const { payload } = await jwtVerify(input.idToken, GOOGLE_JWKS, {
    audience: clientId,
    issuer: ["https://accounts.google.com", "accounts.google.com"],
  });
  if (payload.nonce !== input.nonce) {
    throw new Error("Google token nonce does not match this sign-in");
  }
  if (payload.email_verified !== true || typeof payload.email !== "string") {
    throw new Error("Google did not return a verified email");
  }
  const name = typeof payload.name === "string" ? payload.name : null;
  return { email: payload.email, name };
}
