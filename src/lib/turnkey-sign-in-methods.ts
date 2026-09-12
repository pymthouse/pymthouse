export const SIGN_IN_METHOD_IDS = [
  "google",
  "github",
  "discord",
  "email",
  "passkey",
] as const;

export type SignInMethodId = (typeof SIGN_IN_METHOD_IDS)[number];

export type SignInMethodStatus = {
  id: SignInMethodId;
  label: string;
  linked: boolean;
  canAdd: boolean;
};

type OauthProviderLike = {
  providerName?: string | null;
  issuer?: string | null;
};

type TurnkeyUserLike = {
  userEmail?: string | null;
  oauthProviders?: OauthProviderLike[] | null;
  authenticators?: unknown[] | null;
};

function providerName(provider: OauthProviderLike): string {
  return (provider.providerName ?? "").toLowerCase();
}

function providerIssuer(provider: OauthProviderLike): string {
  return (provider.issuer ?? "").toLowerCase();
}

export function hasGoogleOauthProvider(
  providers: OauthProviderLike[] | null | undefined,
): boolean {
  return (providers ?? []).some((provider) => {
    const name = providerName(provider);
    const issuer = providerIssuer(provider);
    return name.includes("google") || issuer.includes("accounts.google.com");
  });
}

export function hasGithubOauthProvider(
  providers: OauthProviderLike[] | null | undefined,
): boolean {
  return (providers ?? []).some((provider) => {
    const name = providerName(provider);
    const issuer = providerIssuer(provider);
    return name.includes("github") || issuer.includes("turnkey-github");
  });
}

export function hasDiscordOauthProvider(
  providers: OauthProviderLike[] | null | undefined,
): boolean {
  return (providers ?? []).some((provider) => {
    const name = providerName(provider);
    const issuer = providerIssuer(provider);
    return name.includes("discord") || issuer.includes("discord");
  });
}

export function signInMethodStatuses(input: {
  user?: TurnkeyUserLike | null;
  googleEnabled: boolean;
  githubEnabled: boolean;
  discordEnabled: boolean;
}): SignInMethodStatus[] {
  const providers = input.user?.oauthProviders ?? [];
  const emailLinked = Boolean(input.user?.userEmail?.trim());
  const passkeyLinked = (input.user?.authenticators?.length ?? 0) > 0;

  return [
    {
      id: "google",
      label: "Google",
      linked: hasGoogleOauthProvider(providers),
      canAdd: input.googleEnabled,
    },
    {
      id: "github",
      label: "GitHub",
      linked: hasGithubOauthProvider(providers),
      canAdd: input.githubEnabled,
    },
    {
      id: "discord",
      label: "Discord",
      linked: hasDiscordOauthProvider(providers),
      canAdd: input.discordEnabled,
    },
    {
      id: "email",
      label: "Email",
      linked: emailLinked,
      canAdd: false,
    },
    {
      id: "passkey",
      label: "Passkey",
      linked: passkeyLinked,
      canAdd: false,
    },
  ];
}
