import { v4 as uuidv4 } from "uuid";
import { eq, sql } from "drizzle-orm";
import { DEFAULT_ETHEREUM_ACCOUNTS, DEFAULT_SOLANA_ACCOUNTS } from "@turnkey/sdk-server";
import { db } from "@/db/index";
import { users } from "@/db/schema";
import { getTurnkeyServerApiClient } from "@/lib/onramp/turnkey-client";
import { mintTurnkeyGithubOidcToken } from "@/lib/turnkey-github-oidc";
import {
  isPlaceholderTurnkeyEmail,
  normalizeTurnkeyEmail,
  verifyTurnkeySessionJwt,
} from "@/lib/turnkey";
import {
  mintTurnkeyWalletOidcToken,
  turnkeyOauthNonceFromPublicKey,
} from "@/lib/turnkey-wallet-oidc";
import { TURNKEY_WALLET_PROVIDER_NAME } from "@/lib/turnkey-wallet-provider";
import type { OtpClientSignature } from "@/lib/turnkey-otp";

export class WalletLoginError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WalletLoginError";
    this.code = code;
  }
}

export type WalletLoginMethod = "email" | "google" | "github" | "discord";

export type WalletLoginInput = {
  verifiedEmail: string;
  publicKey: string;
  method: WalletLoginMethod;
  name?: string | null;
  googleIdToken?: string;
  discordIdToken?: string;
  githubUserId?: string | number;
  githubLogin?: string | null;
  otp?: {
    verificationToken: string;
    clientSignature: OtpClientSignature;
  };
};

export type WalletLoginResult =
  | {
      kind: "session";
      sessionToken: string;
      subOrganizationId: string;
      userId: string;
      outcome: "migrated_direct" | "new_signup";
    }
  | {
      kind: "confirm-email";
      email: string;
      subOrganizationId: string;
    }
  | {
      kind: "attach";
      sessionToken: string;
      subOrganizationId: string;
      turnkeyUserId: string;
      userId: string;
      registrationToken: string;
      outcome: "migrated_email_code" | "migrated_legacy";
    };

type OauthProviderLike = {
  providerName?: string | null;
  issuer?: string | null;
};

type WalletUserRow = {
  id: string;
  email: string | null;
  name: string | null;
  turnkeyUserId: string | null;
  turnkeySubOrgId: string | null;
  walletLinkedAt: string | null;
};

type WalletLoginClient = {
  getSubOrgIds(input: {
    organizationId: string;
    filterType: "OIDC_TOKEN";
    filterValue: string;
  }): Promise<{ organizationIds?: string[] }>;
  getVerifiedSubOrgIds(input: {
    organizationId: string;
    filterType: "EMAIL";
    filterValue: string;
  }): Promise<{ organizationIds?: string[] }>;
  getUsers(input: { organizationId: string }): Promise<{
    users?: Array<{
      userId?: string;
      oauthProviders?: OauthProviderLike[];
    }>;
  }>;
  createSubOrganization(input: {
    organizationId: string;
    subOrganizationName: string;
    rootQuorumThreshold: number;
    rootUsers: Array<{
      userName: string;
      userEmail?: string;
      apiKeys: unknown[];
      authenticators: unknown[];
      oauthProviders: Array<{ providerName: string; oidcToken: string }>;
    }>;
    wallet: { walletName: string; accounts: unknown[] };
  }): Promise<{ subOrganizationId?: string }>;
  oauthLogin(input: {
    organizationId: string;
    oidcToken: string;
    publicKey: string;
  }): Promise<{ session?: string | null }>;
  otpLogin(input: {
    organizationId: string;
    verificationToken: string;
    publicKey: string;
    clientSignature: OtpClientSignature;
  }): Promise<{ session?: string | null }>;
};

export type WalletLoginDeps = {
  parentOrganizationId(): string;
  getClient(): WalletLoginClient;
  mintWalletToken(input: {
    userId: string;
    nonce: string;
    email?: string | null;
    name?: string | null;
  }): Promise<string>;
  mintGithubToken(input: {
    githubUserId: string | number;
    nonce: string;
    email?: string | null;
    name?: string | null;
    login?: string | null;
  }): Promise<string>;
  findByEmail(email: string): Promise<WalletUserRow[]>;
  findByTurnkeyUserId(turnkeyUserId: string): Promise<WalletUserRow | null>;
  insertUser(input: {
    id: string;
    email: string;
    name: string | null;
    turnkeyUserId: string | null;
    turnkeySubOrgId: string | null;
    walletLinkedAt: string | null;
  }): Promise<void>;
  updateUser(
    id: string,
    patch: Partial<
      Pick<
        WalletUserRow,
        "email" | "name" | "turnkeyUserId" | "turnkeySubOrgId" | "walletLinkedAt"
      >
    >,
  ): Promise<void>;
  nowIso(): string;
  log(outcome: string, fields: Record<string, string>): void;
};

function parentOrganizationId(): string {
  return (
    process.env.TURNKEY_ORG_ID?.trim() ||
    process.env.NEXT_PUBLIC_ORGANIZATION_ID?.trim() ||
    ""
  );
}

const defaultDeps: WalletLoginDeps = {
  parentOrganizationId,
  getClient: () => getTurnkeyServerApiClient() as WalletLoginClient,
  mintWalletToken: mintTurnkeyWalletOidcToken,
  mintGithubToken: mintTurnkeyGithubOidcToken,
  async findByEmail(email) {
    return db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        turnkeyUserId: users.turnkeyUserId,
        turnkeySubOrgId: users.turnkeySubOrgId,
        walletLinkedAt: users.walletLinkedAt,
      })
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`);
  },
  async findByTurnkeyUserId(turnkeyUserId) {
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        turnkeyUserId: users.turnkeyUserId,
        turnkeySubOrgId: users.turnkeySubOrgId,
        walletLinkedAt: users.walletLinkedAt,
      })
      .from(users)
      .where(eq(users.turnkeyUserId, turnkeyUserId))
      .limit(1);
    return rows[0] ?? null;
  },
  async insertUser(input) {
    await db.insert(users).values({
      id: input.id,
      email: input.email,
      name: input.name,
      oauthProvider: "turnkey-wallet",
      oauthSubject: input.turnkeyUserId || input.id,
      role: "developer",
      turnkeyUserId: input.turnkeyUserId,
      turnkeySubOrgId: input.turnkeySubOrgId,
      walletLinkedAt: input.walletLinkedAt,
    });
  },
  async updateUser(id, patch) {
    await db.update(users).set(patch).where(eq(users.id, id));
  },
  nowIso: () => new Date().toISOString(),
  log(outcome, fields) {
    console.info("wallet login", { outcome, ...fields });
  },
};

function requireEmail(raw: string): string {
  const email = normalizeTurnkeyEmail(raw);
  if (!email || !email.includes("@") || email.endsWith("@turnkey.local")) {
    throw new WalletLoginError(
      "blocked_no_email",
      "A verified email address is required before a wallet can be created.",
    );
  }
  return email;
}

function providerKind(provider: OauthProviderLike): string {
  const name = (provider.providerName ?? "").toLowerCase();
  const issuer = (provider.issuer ?? "").toLowerCase();
  if (issuer.includes("accounts.google.com") || name === "google") return "google";
  if (issuer.includes("turnkey-github-oidc") || name.includes("github")) return "github";
  if (name.includes("discord") || issuer.includes("discord")) return "discord";
  if (issuer.includes("turnkey-wallet-oidc") || name === "pymthouse") return "wallet";
  return "other";
}

function sessionOrThrow(session: string | null | undefined, code: string): string {
  const token = session?.trim();
  if (!token) throw new WalletLoginError(code, "Turnkey did not return a session");
  return token;
}

async function singleVerifiedSubOrg(
  deps: WalletLoginDeps,
  email: string,
): Promise<string | null> {
  const parent = deps.parentOrganizationId();
  const verified = await deps.getClient().getVerifiedSubOrgIds({
    organizationId: parent,
    filterType: "EMAIL",
    filterValue: email,
  });
  const ids = verified.organizationIds ?? [];
  if (ids.length > 1) {
    throw new WalletLoginError(
      "email_conflict",
      "This email is verified on more than one wallet. Contact support before signing in.",
    );
  }
  return ids[0] ?? null;
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return email;
  return `${local.slice(0, 1)}***@${domain}`;
}

export async function completeWalletLogin(
  input: WalletLoginInput,
  deps: WalletLoginDeps = defaultDeps,
): Promise<WalletLoginResult> {
  const email = requireEmail(input.verifiedEmail);
  const publicKey = input.publicKey.trim();
  if (!publicKey) {
    throw new WalletLoginError("invalid_public_key", "A session public key is required.");
  }
  const nonce = turnkeyOauthNonceFromPublicKey(publicKey);
  const parent = deps.parentOrganizationId();
  if (!parent) {
    throw new WalletLoginError(
      "not_configured",
      "Turnkey organization is not configured.",
    );
  }

  const matches = await deps.findByEmail(email);
  if (matches.length > 1) {
    throw new WalletLoginError(
      "email_conflict",
      "This email is already on more than one PymtHouse account.",
    );
  }
  let user = matches[0] ?? null;

  if (user) {
    const linked = await loginWithWalletToken(deps, user, publicKey, nonce, email);
    if (linked) return linked;
  }

  const knownSubOrg =
    user?.turnkeySubOrgId?.trim() || (await singleVerifiedSubOrg(deps, email));

  if (knownSubOrg) {
    const legacy = await loginLegacy(deps, {
      user,
      email,
      publicKey,
      nonce,
      subOrganizationId: knownSubOrg,
      input,
    });
    if (legacy) return legacy;
    deps.log("confirm_email", { method: input.method, subOrganizationId: knownSubOrg });
    return { kind: "confirm-email", email, subOrganizationId: knownSubOrg };
  }

  return createWallet(deps, { user, email, name: input.name, publicKey, nonce });
}

async function loginWithWalletToken(
  deps: WalletLoginDeps,
  user: WalletUserRow,
  publicKey: string,
  nonce: string,
  email: string,
): Promise<WalletLoginResult | null> {
  const probe = await deps.mintWalletToken({
    userId: user.id,
    nonce,
    email,
    name: user.name,
  });
  const found = await deps.getClient().getSubOrgIds({
    organizationId: deps.parentOrganizationId(),
    filterType: "OIDC_TOKEN",
    filterValue: probe,
  });
  const subOrganizationId = found.organizationIds?.[0];
  if (!subOrganizationId) return null;
  const loginToken = await deps.mintWalletToken({
    userId: user.id,
    nonce,
    email,
    name: user.name,
  });
  const sessionToken = sessionOrThrow(
    (
      await deps.getClient().oauthLogin({
        organizationId: subOrganizationId,
        oidcToken: loginToken,
        publicKey,
      })
    ).session,
    "oauth_login_failed",
  );
  await deps.updateUser(user.id, {
    turnkeySubOrgId: subOrganizationId,
    walletLinkedAt: user.walletLinkedAt || deps.nowIso(),
  });
  deps.log("migrated_direct", { userId: user.id, subOrganizationId });
  return {
    kind: "session",
    sessionToken,
    subOrganizationId,
    userId: user.id,
    outcome: "migrated_direct",
  };
}

async function loginLegacy(
  deps: WalletLoginDeps,
  args: {
    user: WalletUserRow | null;
    email: string;
    publicKey: string;
    nonce: string;
    subOrganizationId: string;
    input: WalletLoginInput;
  },
): Promise<WalletLoginResult | null> {
  const client = deps.getClient();
  const usersResult = await client.getUsers({
    organizationId: args.subOrganizationId,
  });
  const tkUser = usersResult.users?.[0];
  const kinds = new Set((tkUser?.oauthProviders ?? []).map(providerKind));

  if (args.input.method === "google" && args.input.googleIdToken && kinds.has("google")) {
    return finishLegacy(deps, args, tkUser?.userId, "migrated_legacy", async () =>
      client.oauthLogin({
        organizationId: args.subOrganizationId,
        oidcToken: args.input.googleIdToken!,
        publicKey: args.publicKey,
      }),
    );
  }
  if (args.input.method === "discord" && args.input.discordIdToken && kinds.has("discord")) {
    return finishLegacy(deps, args, tkUser?.userId, "migrated_legacy", async () =>
      client.oauthLogin({
        organizationId: args.subOrganizationId,
        oidcToken: args.input.discordIdToken!,
        publicKey: args.publicKey,
      }),
    );
  }
  if (
    args.input.method === "github" &&
    args.input.githubUserId &&
    kinds.has("github")
  ) {
    const oidcToken = await deps.mintGithubToken({
      githubUserId: args.input.githubUserId,
      nonce: args.nonce,
      email: args.email,
      name: args.input.name,
      login: args.input.githubLogin,
    });
    return finishLegacy(deps, args, tkUser?.userId, "migrated_legacy", async () =>
      client.oauthLogin({
        organizationId: args.subOrganizationId,
        oidcToken,
        publicKey: args.publicKey,
      }),
    );
  }
  if (args.input.otp) {
    return finishLegacy(deps, args, tkUser?.userId, "migrated_email_code", async () =>
      client.otpLogin({
        organizationId: args.subOrganizationId,
        verificationToken: args.input.otp!.verificationToken,
        publicKey: args.publicKey,
        clientSignature: args.input.otp!.clientSignature,
      }),
    );
  }
  if (kinds.has("wallet")) return null;
  return null;
}

async function finishLegacy(
  deps: WalletLoginDeps,
  args: {
    user: WalletUserRow | null;
    email: string;
    publicKey: string;
    nonce: string;
    subOrganizationId: string;
    input: WalletLoginInput;
  },
  turnkeyUserId: string | undefined,
  outcome: "migrated_legacy" | "migrated_email_code",
  login: () => Promise<{ session?: string | null }>,
): Promise<WalletLoginResult> {
  const sessionToken = sessionOrThrow((await login()).session, "legacy_login_failed");
  const claims = await verifyTurnkeySessionJwt(sessionToken);
  const resolvedTurnkeyUserId = claims?.userId || turnkeyUserId;
  if (!resolvedTurnkeyUserId) {
    throw new WalletLoginError("legacy_login_failed", "Turnkey session has no user.");
  }
  let user = args.user;
  if (!user) {
    user = await deps.findByTurnkeyUserId(resolvedTurnkeyUserId);
  }
  if (!user) {
    const id = uuidv4();
    await deps.insertUser({
      id,
      email: args.email,
      name: args.input.name?.trim() || null,
      turnkeyUserId: resolvedTurnkeyUserId,
      turnkeySubOrgId: args.subOrganizationId,
      walletLinkedAt: null,
    });
    user = {
      id,
      email: args.email,
      name: args.input.name?.trim() || null,
      turnkeyUserId: resolvedTurnkeyUserId,
      turnkeySubOrgId: args.subOrganizationId,
      walletLinkedAt: null,
    };
  } else {
    await deps.updateUser(user.id, {
      email: isPlaceholderTurnkeyEmail(user.email, user.turnkeyUserId ?? "")
        ? args.email
        : user.email,
      turnkeyUserId: user.turnkeyUserId || resolvedTurnkeyUserId,
      turnkeySubOrgId: args.subOrganizationId,
    });
  }
  const registrationToken = await deps.mintWalletToken({
    userId: user.id,
    nonce: args.nonce,
    email: args.email,
    name: user.name,
  });
  deps.log(outcome, { userId: user.id, subOrganizationId: args.subOrganizationId });
  return {
    kind: "attach",
    sessionToken,
    subOrganizationId: args.subOrganizationId,
    turnkeyUserId: resolvedTurnkeyUserId,
    userId: user.id,
    registrationToken,
    outcome,
  };
}

async function createWallet(
  deps: WalletLoginDeps,
  args: {
    user: WalletUserRow | null;
    email: string;
    name?: string | null;
    publicKey: string;
    nonce: string;
  },
): Promise<WalletLoginResult> {
  const verified = await singleVerifiedSubOrg(deps, args.email);
  if (verified) {
    return {
      kind: "confirm-email",
      email: args.email,
      subOrganizationId: verified,
    };
  }
  let user = args.user;
  if (!user) {
    const id = uuidv4();
    await deps.insertUser({
      id,
      email: args.email,
      name: args.name?.trim() || null,
      turnkeyUserId: null,
      turnkeySubOrgId: null,
      walletLinkedAt: null,
    });
    user = {
      id,
      email: args.email,
      name: args.name?.trim() || null,
      turnkeyUserId: null,
      turnkeySubOrgId: null,
      walletLinkedAt: null,
    };
  }
  const registrationToken = await deps.mintWalletToken({
    userId: user.id,
    nonce: args.nonce,
    email: args.email,
    name: args.name,
  });
  const created = await deps.getClient().createSubOrganization({
    organizationId: deps.parentOrganizationId(),
    subOrganizationName: `user-${user.id}`,
    rootQuorumThreshold: 1,
    rootUsers: [
      {
        userName: args.email,
        userEmail: args.email,
        apiKeys: [],
        authenticators: [],
        oauthProviders: [
          {
            providerName: TURNKEY_WALLET_PROVIDER_NAME,
            oidcToken: registrationToken,
          },
        ],
      },
    ],
    wallet: {
      walletName: "Default Wallet",
      accounts: [...DEFAULT_ETHEREUM_ACCOUNTS, ...DEFAULT_SOLANA_ACCOUNTS],
    },
  });
  const subOrganizationId = created.subOrganizationId;
  if (!subOrganizationId) {
    throw new WalletLoginError("create_failed", "Turnkey did not create a wallet.");
  }
  const createdUsers = await deps.getClient().getUsers({ organizationId: subOrganizationId });
  const turnkeyUserId = createdUsers.users?.[0]?.userId;
  if (!turnkeyUserId) {
    throw new WalletLoginError("create_failed", "Turnkey wallet has no user.");
  }
  const loginToken = await deps.mintWalletToken({
    userId: user.id,
    nonce: args.nonce,
    email: args.email,
    name: args.name,
  });
  const sessionToken = sessionOrThrow(
    (
      await deps.getClient().oauthLogin({
        organizationId: subOrganizationId,
        oidcToken: loginToken,
        publicKey: args.publicKey,
      })
    ).session,
    "oauth_login_failed",
  );
  const linkedAt = deps.nowIso();
  await deps.updateUser(user.id, {
    turnkeyUserId,
    turnkeySubOrgId: subOrganizationId,
    walletLinkedAt: linkedAt,
    name: user.name || args.name?.trim() || null,
  });
  deps.log("new_signup", { userId: user.id, subOrganizationId });
  return {
    kind: "session",
    sessionToken,
    subOrganizationId,
    userId: user.id,
    outcome: "new_signup",
  };
}

export async function claimVerifiedEmailForUser(
  input: {
    userId: string;
    verifiedEmail: string;
    publicKey: string;
    otp?: WalletLoginInput["otp"];
  },
  deps: WalletLoginDeps = defaultDeps,
): Promise<WalletLoginResult | { kind: "updated" }> {
  const email = requireEmail(input.verifiedEmail);
  const owned = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      turnkeyUserId: users.turnkeyUserId,
      turnkeySubOrgId: users.turnkeySubOrgId,
      walletLinkedAt: users.walletLinkedAt,
    })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);
  const row = owned[0];
  if (!row) throw new WalletLoginError("not_found", "Account not found.");
  if (
    row.email &&
    !isPlaceholderTurnkeyEmail(row.email, row.turnkeyUserId ?? "") &&
    normalizeTurnkeyEmail(row.email) !== email
  ) {
    throw new WalletLoginError(
      "email_conflict",
      "This account already has a different email.",
    );
  }
  const taken = (await deps.findByEmail(email)).filter((match) => match.id !== row.id);
  if (taken.length > 0) {
    throw new WalletLoginError(
      "email_conflict",
      "That email already belongs to another PymtHouse account.",
    );
  }
  await deps.updateUser(row.id, { email });
  if (row.turnkeySubOrgId && !row.walletLinkedAt && input.otp) {
    return completeWalletLogin(
      {
        verifiedEmail: email,
        publicKey: input.publicKey,
        method: "email",
        otp: input.otp,
        name: row.name,
      },
      deps,
    );
  }
  return { kind: "updated" };
}
