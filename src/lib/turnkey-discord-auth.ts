import { createRemoteJWKSet, jwtVerify } from "jose";
import { getPublicOrigin } from "@/lib/oidc/issuer-urls";

const DISCORD_JWKS = createRemoteJWKSet(
  new URL("https://discord.com/api/oauth2/keys"),
);

function trimEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function getDiscordOAuthClientId(): string | undefined {
  return (
    trimEnv(process.env.DISCORD_CLIENT_ID) ||
    trimEnv(process.env.NEXT_PUBLIC_TURNKEY_DISCORD_CLIENT_ID)
  );
}

export function getDiscordOAuthClientSecret(): string | undefined {
  return trimEnv(process.env.DISCORD_CLIENT_SECRET);
}

export function isDiscordWalletLoginConfigured(): boolean {
  return Boolean(getDiscordOAuthClientId() && getDiscordOAuthClientSecret());
}

export function discordOAuthCallbackUrl(): string {
  return `${getPublicOrigin()}/api/auth/discord/callback`;
}

export function discordAuthorizeUrl(input: {
  state: string;
  clientId: string;
  nonce: string;
}): string {
  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", discordOAuthCallbackUrl());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "identify email openid");
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

export async function exchangeDiscordOAuthCode(code: string): Promise<{
  accessToken: string;
  idToken: string | null;
}> {
  const clientId = getDiscordOAuthClientId();
  const clientSecret = getDiscordOAuthClientSecret();
  if (!clientId || !clientSecret) throw new Error("Discord OAuth is not configured");
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: discordOAuthCallbackUrl(),
    grant_type: "authorization_code",
  });
  const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!tokenRes.ok) throw new Error(`Discord token exchange failed (${tokenRes.status})`);
  const json = (await tokenRes.json()) as {
    access_token?: string;
    id_token?: string;
  };
  if (!json.access_token) throw new Error("Discord token exchange returned no access_token");
  return { accessToken: json.access_token, idToken: json.id_token ?? null };
}

export async function verifyDiscordIdentity(input: {
  accessToken: string;
  idToken: string | null;
  nonce: string;
}): Promise<{ email: string; name: string | null; idToken: string | null }> {
  const userRes = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${input.accessToken}` },
  });
  if (!userRes.ok) throw new Error(`Discord user lookup failed (${userRes.status})`);
  const user = (await userRes.json()) as {
    email?: string;
    verified?: boolean;
    global_name?: string;
    username?: string;
  };
  if (user.verified !== true || !user.email?.trim()) {
    throw new Error("Discord did not return a verified email");
  }
  if (input.idToken) {
    const clientId = getDiscordOAuthClientId();
    if (!clientId) throw new Error("Discord OAuth is not configured");
    const { payload } = await jwtVerify(input.idToken, DISCORD_JWKS, {
      audience: clientId,
    });
    if (payload.nonce && payload.nonce !== input.nonce) {
      throw new Error("Discord token nonce does not match this sign-in");
    }
  }
  return {
    email: user.email.trim(),
    name: user.global_name?.trim() || user.username?.trim() || null,
    idToken: input.idToken,
  };
}
