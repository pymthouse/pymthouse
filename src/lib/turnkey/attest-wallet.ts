import { db } from "@/db/index";
import { endUsers, users } from "@/db/schema";
import { and, eq, ne } from "drizzle-orm";
import { findOrCreateAppEndUser } from "@/lib/billing/end-users";
import {
  normalizeWalletAddress,
  verifyTurnkeySessionJwt,
} from "@/lib/turnkey";
import {
  getTurnkeyEvmAddressesForOrg,
  getTurnkeyServerClient,
} from "@/lib/turnkey/server-client";

export class MultiAccountWalletError extends Error {
  readonly attestedAddresses: string[];

  constructor(attestedAddresses: string[]) {
    super("Multiple wallet accounts require an explicit walletAddress hint");
    this.name = "MultiAccountWalletError";
    this.attestedAddresses = attestedAddresses;
  }
}

export class WalletBindingConflictError extends Error {
  readonly field: "wallet" | "turnkey_user" | "turnkey_sub_org";

  constructor(
    message: string,
    field: "wallet" | "turnkey_user" | "turnkey_sub_org",
  ) {
    super(message);
    this.name = "WalletBindingConflictError";
    this.field = field;
  }
}

export class TurnkeyAttestationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TurnkeyAttestationError";
  }
}

export type ResolveAttestedWalletInput = {
  organizationId: string;
  clientHint?: string | null;
  /** When Turnkey API key is configured, require a non-empty attested address list. */
  requireAttestation?: boolean;
};

export async function resolveAttestedWalletAddress(
  input: ResolveAttestedWalletInput,
): Promise<{ walletAddress: string | null; attestedAddresses: string[] }> {
  const clientHint = normalizeWalletAddress(input.clientHint);
  let attested: string[];
  try {
    attested = await getTurnkeyEvmAddressesForOrg(input.organizationId);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Turnkey getWalletAccounts failed";
    throw new TurnkeyAttestationError(message);
  }

  const turnkeyConfigured = Boolean(getTurnkeyServerClient());

  if (attested.length > 1) {
    if (!clientHint || !attested.includes(clientHint)) {
      throw new MultiAccountWalletError(attested);
    }
    return { walletAddress: clientHint, attestedAddresses: attested };
  }

  if (attested.length === 1) {
    const walletAddress =
      clientHint && attested.includes(clientHint) ? clientHint : attested[0];
    return { walletAddress, attestedAddresses: attested };
  }

  if (turnkeyConfigured && input.requireAttestation) {
    throw new TurnkeyAttestationError(
      "No EVM wallet accounts found for this Turnkey organization",
    );
  }

  return { walletAddress: clientHint, attestedAddresses: attested };
}

export async function assertDeveloperWalletBindingAvailable(input: {
  walletAddress: string | null;
  turnkeyUserId: string;
  excludeUserId: string;
}): Promise<void> {
  const conflictUser = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.turnkeyUserId, input.turnkeyUserId))
    .limit(1);
  if (conflictUser[0] && conflictUser[0].id !== input.excludeUserId) {
    throw new WalletBindingConflictError(
      "This Turnkey wallet is already linked to another account.",
      "turnkey_user",
    );
  }

  if (!input.walletAddress) return;

  const walletConflictUser = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.walletAddress, input.walletAddress),
        ne(users.id, input.excludeUserId),
      ),
    )
    .limit(1);
  if (walletConflictUser[0]) {
    throw new WalletBindingConflictError(
      "This wallet address is already linked to another account.",
      "wallet",
    );
  }

  const walletConflictEndUser = await db
    .select({ id: endUsers.id })
    .from(endUsers)
    .where(eq(endUsers.walletAddress, input.walletAddress))
    .limit(1);
  if (walletConflictEndUser[0]) {
    throw new WalletBindingConflictError(
      "This wallet address is already linked to another user.",
      "wallet",
    );
  }
}

export async function assertAppEndUserWalletBindingAvailable(input: {
  walletAddress: string | null;
  turnkeyUserId: string;
  turnkeySubOrgId: string;
  appId: string;
  externalUserId: string;
  excludeEndUserId?: string;
}): Promise<void> {
  const turnkeyUserConflict = await db
    .select({ id: endUsers.id })
    .from(endUsers)
    .where(eq(endUsers.turnkeyUserId, input.turnkeyUserId))
    .limit(1);
  if (
    turnkeyUserConflict[0] &&
    turnkeyUserConflict[0].id !== input.excludeEndUserId
  ) {
    throw new WalletBindingConflictError(
      "This Turnkey user is already linked to another end user.",
      "turnkey_user",
    );
  }

  const subOrgConflict = await db
    .select({
      id: endUsers.id,
      appId: endUsers.appId,
      externalUserId: endUsers.externalUserId,
    })
    .from(endUsers)
    .where(eq(endUsers.turnkeySubOrgId, input.turnkeySubOrgId))
    .limit(1);
  if (subOrgConflict[0]) {
    const sameUser =
      subOrgConflict[0].id === input.excludeEndUserId ||
      (subOrgConflict[0].appId === input.appId &&
        subOrgConflict[0].externalUserId === input.externalUserId);
    if (!sameUser) {
      throw new WalletBindingConflictError(
        "This Turnkey organization is already linked to another end user.",
        "turnkey_sub_org",
      );
    }
  }

  if (!input.walletAddress) return;

  const walletConflictUser = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.walletAddress, input.walletAddress))
    .limit(1);
  if (walletConflictUser[0]) {
    throw new WalletBindingConflictError(
      "This wallet address is already linked to another account.",
      "wallet",
    );
  }

  const walletConflictEndUser = await db
    .select({ id: endUsers.id })
    .from(endUsers)
    .where(eq(endUsers.walletAddress, input.walletAddress))
    .limit(1);
  if (
    walletConflictEndUser[0] &&
    walletConflictEndUser[0].id !== input.excludeEndUserId
  ) {
    throw new WalletBindingConflictError(
      "This wallet address is already linked to another user.",
      "wallet",
    );
  }
}

export type AttestAppEndUserWalletResult = {
  endUserId: string;
  externalUserId: string;
  walletAddress: string | null;
  turnkeyOrgId: string;
  turnkeyUserId: string;
  isNew: boolean;
};

export async function attestAppEndUserWallet(input: {
  appId: string;
  externalUserId: string;
  turnkeySessionJwt: string;
  walletHint?: string;
}): Promise<AttestAppEndUserWalletResult> {
  const claims = await verifyTurnkeySessionJwt(input.turnkeySessionJwt, {
    skipOrgAllowlist: true,
  });
  if (!claims) {
    throw new Error("Invalid or expired Turnkey session");
  }

  const turnkeyConfigured = Boolean(getTurnkeyServerClient());
  const { walletAddress } = await resolveAttestedWalletAddress({
    organizationId: claims.organizationId,
    clientHint: input.walletHint,
    requireAttestation: turnkeyConfigured,
  });

  const existingRows = await db
    .select({ id: endUsers.id })
    .from(endUsers)
    .where(
      and(
        eq(endUsers.appId, input.appId),
        eq(endUsers.externalUserId, input.externalUserId),
      ),
    )
    .limit(1);

  await assertAppEndUserWalletBindingAvailable({
    walletAddress,
    turnkeyUserId: claims.userId,
    turnkeySubOrgId: claims.organizationId,
    appId: input.appId,
    externalUserId: input.externalUserId,
    excludeEndUserId: existingRows[0]?.id,
  });

  const { id: endUserId, isNew } = await findOrCreateAppEndUser(
    input.appId,
    input.externalUserId,
    {
      walletAddress: walletAddress ?? undefined,
      turnkeySubOrgId: claims.organizationId,
      turnkeyUserId: claims.userId,
    },
  );

  return {
    endUserId,
    externalUserId: input.externalUserId,
    walletAddress,
    turnkeyOrgId: claims.organizationId,
    turnkeyUserId: claims.userId,
    isNew,
  };
}
