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
  removable: boolean;
};

type OauthProviderLike = {
  providerId?: string | null;
  providerName?: string | null;
  issuer?: string | null;
  subject?: string | null;
};

export type BrandedSignIn = {
  provider: "google" | "github" | "discord" | "wallet";
  label: string;
  userId: string;
};

const BRANDED_PROVIDER_LABELS = {
  google: "Google",
  github: "GitHub",
  discord: "Discord",
} as const;

function providerMatches(
  id: keyof typeof BRANDED_PROVIDER_LABELS,
  provider: OauthProviderLike,
): boolean {
  if (id === "google") return hasGoogleOauthProvider([provider]);
  if (id === "github") return hasGithubOauthProvider([provider]);
  return hasDiscordOauthProvider([provider]);
}

function visibleSubject(
  provider: keyof typeof BRANDED_PROVIDER_LABELS,
  subject: string,
): string {
  if (provider === "github" && subject.toLowerCase().startsWith("github:")) {
    return subject.slice("github:".length);
  }
  return subject;
}

/** Provider mark plus the id that provider uses for this person. */
export function brandedSignInIdentity(
  providers: OauthProviderLike[] | null | undefined,
  fallbackName?: string | null,
): BrandedSignIn | null {
  for (const providerId of ["discord", "google", "github"] as const) {
    const match = (providers ?? []).find((provider) => providerMatches(providerId, provider));
    if (!match) continue;
    const raw = match.subject?.trim() ?? "";
    const userId = raw ? visibleSubject(providerId, raw) : (fallbackName?.trim() ?? "");
    if (!userId) continue;
    return {
      provider: providerId,
      label: BRANDED_PROVIDER_LABELS[providerId],
      userId,
    };
  }
  const name = fallbackName?.trim();
  if (!name) return null;
  return { provider: "wallet", label: "Account", userId: name };
}

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

function hostnameFromUrl(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function issuerHostMatches(
  issuer: string,
  allowedHosts: readonly string[],
): boolean {
  const host = hostnameFromUrl(issuer);
  return host !== null && allowedHosts.includes(host);
}

export function hasGoogleOauthProvider(
  providers: OauthProviderLike[] | null | undefined,
): boolean {
  return (providers ?? []).some((provider) => {
    const name = providerName(provider);
    const issuer = providerIssuer(provider);
    return name.includes("google") || issuerHostMatches(issuer, ["accounts.google.com"]);
  });
}

export function hasGithubOauthProvider(
  providers: OauthProviderLike[] | null | undefined,
): boolean {
  return (providers ?? []).some((provider) => {
    const name = providerName(provider);
    const issuer = providerIssuer(provider);
    return name.includes("github") || issuerHostMatches(issuer, ["github.com"]);
  });
}

export function hasDiscordOauthProvider(
  providers: OauthProviderLike[] | null | undefined,
): boolean {
  return (providers ?? []).some((provider) => {
    const name = providerName(provider);
    const issuer = providerIssuer(provider);
    return (
      name.includes("discord") ||
      issuerHostMatches(issuer, ["discord.com", "discordapp.com"])
    );
  });
}

function methodIsLinked(
  id: SignInMethodId,
  providers: OauthProviderLike[],
  emailLinked: boolean,
  passkeyLinked: boolean,
): boolean {
  if (id === "google") return hasGoogleOauthProvider(providers);
  if (id === "github") return hasGithubOauthProvider(providers);
  if (id === "discord") return hasDiscordOauthProvider(providers);
  if (id === "email") return emailLinked;
  return passkeyLinked;
}

export function oauthProviderIdForMethod(
  providers: OauthProviderLike[] | null | undefined,
  method: SignInMethodId,
): string | null {
  const list = providers ?? [];
  const match = list.find((provider) => {
    if (method === "google") return hasGoogleOauthProvider([provider]);
    if (method === "github") return hasGithubOauthProvider([provider]);
    if (method === "discord") return hasDiscordOauthProvider([provider]);
    return false;
  });
  const id = match?.providerId?.trim();
  return id || null;
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
  const linkedCount = SIGN_IN_METHOD_IDS.filter((id) =>
    methodIsLinked(id, providers, emailLinked, passkeyLinked),
  ).length;
  const canRemove = linkedCount > 1;

  return [
    {
      id: "google",
      label: "Google",
      linked: hasGoogleOauthProvider(providers),
      canAdd: input.googleEnabled,
      removable: hasGoogleOauthProvider(providers) && canRemove,
    },
    {
      id: "github",
      label: "GitHub",
      linked: hasGithubOauthProvider(providers),
      canAdd: input.githubEnabled,
      removable: hasGithubOauthProvider(providers) && canRemove,
    },
    {
      id: "discord",
      label: "Discord",
      linked: hasDiscordOauthProvider(providers),
      canAdd: input.discordEnabled,
      removable: hasDiscordOauthProvider(providers) && canRemove,
    },
    {
      id: "email",
      label: "Email",
      linked: emailLinked,
      canAdd: false,
      removable: emailLinked && canRemove,
    },
    {
      id: "passkey",
      label: "Passkey",
      linked: passkeyLinked,
      canAdd: false,
      removable: false,
    },
  ];
}
