import {
  DEFAULT_ETHEREUM_ACCOUNTS,
  DEFAULT_SOLANA_ACCOUNTS,
} from "@turnkey/sdk-server";
import { getTurnkeyServerApiClient } from "@/lib/onramp/turnkey-client";
import {
  mintTurnkeyGithubOidcToken,
  TURNKEY_GITHUB_PROVIDER_NAME,
  turnkeyOauthNonceFromPublicKey,
} from "@/lib/turnkey-github-oidc";
import { getPublicOrigin } from "@/lib/oidc/issuer-urls";
import { isTurnkeyWalletConfigured } from "@/lib/turnkey";

export type GithubUserProfile = {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
};

type TurnkeyGithubServerClient = {
  getSubOrgIds(input: {
    organizationId: string;
    filterType: "OIDC_TOKEN";
    filterValue: string;
  }): Promise<{ organizationIds?: string[] }>;
  createSubOrganization(input: {
    organizationId: string;
    subOrganizationName: string;
    rootQuorumThreshold: number;
    rootUsers: Array<{
      userName: string;
      userEmail?: string;
      apiKeys: unknown[];
      authenticators: unknown[];
      oauthProviders: Array<{
        providerName: string;
        oidcToken: string;
      }>;
    }>;
    wallet: {
      walletName: string;
      accounts: unknown[];
    };
  }): Promise<{ subOrganizationId?: string }>;
  oauthLogin(input: {
    organizationId: string;
    oidcToken: string;
    publicKey: string;
  }): Promise<{ session?: string | null }>;
};

type LoginTurnkeyWithGithubDeps = {
  mintOidcToken(input: {
    githubUserId: string | number;
    nonce: string;
    email?: string | null;
    name?: string | null;
    login?: string | null;
  }): Promise<string>;
  getClient(): TurnkeyGithubServerClient;
  nowMs(): number;
};

const defaultLoginTurnkeyWithGithubDeps: LoginTurnkeyWithGithubDeps = {
  mintOidcToken: mintTurnkeyGithubOidcToken,
  getClient: () => getTurnkeyServerApiClient() as TurnkeyGithubServerClient,
  nowMs: () => Date.now(),
};

function trimEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function getGithubOAuthClientId(): string | undefined {
  return (
    trimEnv(process.env.GITHUB_CLIENT_ID) ||
    trimEnv(process.env.NEXT_PUBLIC_GITHUB_CLIENT_ID)
  );
}

export function getGithubOAuthClientSecret(): string | undefined {
  return trimEnv(process.env.GITHUB_CLIENT_SECRET);
}

/** True when GitHub → Turnkey wallet login can run end-to-end. */
export function isGithubTurnkeyLoginConfigured(): boolean {
  if (!isTurnkeyWalletConfigured()) return false;
  if (!getGithubOAuthClientId() || !getGithubOAuthClientSecret()) return false;
  if (
    !trimEnv(process.env.TURNKEY_API_PUBLIC_KEY) ||
    !trimEnv(process.env.TURNKEY_API_PRIVATE_KEY)
  ) {
    return false;
  }
  return true;
}

export function githubOAuthCallbackUrl(): string {
  return `${getPublicOrigin()}/api/auth/github/callback`;
}

export function githubAuthorizeUrl(input: {
  state: string;
  clientId: string;
}): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", githubOAuthCallbackUrl());
  url.searchParams.set("scope", "read:user user:email");
  url.searchParams.set("state", input.state);
  return url.toString();
}

export async function exchangeGithubOAuthCode(
  code: string,
): Promise<{ accessToken: string }> {
  const clientId = getGithubOAuthClientId();
  const clientSecret = getGithubOAuthClientSecret();
  if (!clientId || !clientSecret) {
    throw new Error("GitHub OAuth is not configured");
  }

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: githubOAuthCallbackUrl(),
    }),
  });

  if (!tokenRes.ok) {
    throw new Error(`GitHub token exchange failed (${tokenRes.status})`);
  }

  const tokenJson = (await tokenRes.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!tokenJson.access_token) {
    throw new Error(
      tokenJson.error_description ||
        tokenJson.error ||
        "GitHub token exchange returned no access_token",
    );
  }
  return { accessToken: tokenJson.access_token };
}

export async function fetchGithubUserProfile(
  accessToken: string,
): Promise<GithubUserProfile> {
  const userRes = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "pymthouse",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!userRes.ok) {
    throw new Error(`GitHub user lookup failed (${userRes.status})`);
  }
  const userJson = (await userRes.json()) as {
    id?: number;
    login?: string;
    name?: string | null;
    email?: string | null;
  };
  if (typeof userJson.id !== "number" || !userJson.login) {
    throw new Error("GitHub user response missing id/login");
  }

  let email = userJson.email?.trim() || null;
  if (!email) {
    email = await fetchPrimaryGithubEmail(accessToken);
  }

  return {
    id: userJson.id,
    login: userJson.login,
    name: userJson.name?.trim() || null,
    email,
  };
}

async function fetchPrimaryGithubEmail(
  accessToken: string,
): Promise<string | null> {
  const res = await fetch("https://api.github.com/user/emails", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "pymthouse",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) return null;
  const emails = (await res.json()) as Array<{
    email?: string;
    primary?: boolean;
    verified?: boolean;
  }>;
  if (!Array.isArray(emails)) return null;
  const primary =
    emails.find((e) => e.primary && e.verified && e.email) ||
    emails.find((e) => e.verified && e.email) ||
    emails.find((e) => e.email);
  return primary?.email?.trim() || null;
}

function parentOrganizationId(): string {
  return (
    trimEnv(process.env.TURNKEY_ORG_ID) ||
    trimEnv(process.env.NEXT_PUBLIC_ORGANIZATION_ID) ||
    ""
  );
}

/**
 * Create or resume a Turnkey sub-org for a GitHub identity, then oauthLogin.
 * Returns a Turnkey session JWT bound to `publicKey` (Wallet Kit IndexedDB key).
 */
export async function loginTurnkeyWithGithub(input: {
  publicKey: string;
  nonce: string;
  profile: GithubUserProfile;
}, deps: LoginTurnkeyWithGithubDeps = defaultLoginTurnkeyWithGithubDeps): Promise<{ sessionToken: string; subOrganizationId: string }> {
  const expectedNonce = turnkeyOauthNonceFromPublicKey(input.publicKey);
  if (expectedNonce !== input.nonce) {
    throw new Error("OAuth nonce does not match session public key");
  }

  const organizationId = parentOrganizationId();
  if (!organizationId) {
    throw new Error("Missing TURNKEY_ORG_ID / NEXT_PUBLIC_ORGANIZATION_ID");
  }

  const oidcToken = await deps.mintOidcToken({
    githubUserId: input.profile.id,
    nonce: input.nonce,
    email: input.profile.email,
    name: input.profile.name,
    login: input.profile.login,
  });

  const client = deps.getClient();

  const existing = await client.getSubOrgIds({
    organizationId,
    filterType: "OIDC_TOKEN",
    filterValue: oidcToken,
  });

  let subOrganizationId = existing.organizationIds?.[0];
  if (!subOrganizationId) {
    const userName =
      input.profile.email ||
      input.profile.login ||
      `github-${input.profile.id}`;
    const created = await client.createSubOrganization({
      organizationId,
      subOrganizationName: `github-${input.profile.id}-${deps.nowMs()}`,
      rootQuorumThreshold: 1,
      rootUsers: [
        {
          userName,
          ...(input.profile.email
            ? { userEmail: input.profile.email }
            : {}),
          apiKeys: [],
          authenticators: [],
          oauthProviders: [
            {
              providerName: TURNKEY_GITHUB_PROVIDER_NAME,
              oidcToken,
            },
          ],
        },
      ],
      wallet: {
        walletName: "Default Wallet",
        accounts: [
          ...DEFAULT_ETHEREUM_ACCOUNTS,
          ...DEFAULT_SOLANA_ACCOUNTS,
        ],
      },
    });
    subOrganizationId = created.subOrganizationId;
  }

  if (!subOrganizationId) {
    throw new Error("Failed to resolve Turnkey sub-organization");
  }

  // Fresh token for oauthLogin (registration token may already be near expiry).
  const loginOidcToken = await deps.mintOidcToken({
    githubUserId: input.profile.id,
    nonce: input.nonce,
    email: input.profile.email,
    name: input.profile.name,
    login: input.profile.login,
  });

  const loginResult = await client.oauthLogin({
    organizationId: subOrganizationId,
    oidcToken: loginOidcToken,
    publicKey: input.publicKey,
  });

  const sessionToken = loginResult.session?.trim();
  if (!sessionToken) {
    throw new Error("Turnkey oauthLogin returned no session");
  }

  return {
    sessionToken,
    subOrganizationId,
  };
}
