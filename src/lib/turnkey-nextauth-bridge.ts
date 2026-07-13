import { signIn } from "next-auth/react";

type WalletAccount = {
  address: string;
};

type WalletLike = {
  accounts: WalletAccount[];
};

type TurnkeyUserLike = {
  userEmail?: string | null;
  userName?: string | null;
} | null | undefined;

export type TurnkeyBridgeSession = {
  token?: string;
} | null | undefined;

export type TurnkeyNextAuthBridgeDeps = {
  getSession: () => Promise<TurnkeyBridgeSession>;
  refreshUser: () => Promise<unknown>;
  refreshWallets: () => Promise<WalletLike[] | null | undefined>;
  wallets: WalletLike[];
  user: TurnkeyUserLike;
};

export function firstEvmAddressFromWallets(
  wallets: WalletLike[],
): string | undefined {
  for (const w of wallets) {
    for (const a of w.accounts) {
      const addr = a.address;
      if (typeof addr === "string" && addr.startsWith("0x")) {
        return addr;
      }
    }
  }
  return undefined;
}

/**
 * Exchange an authenticated Turnkey session for a NextAuth `turnkey-wallet` session.
 * Callers must ensure Turnkey is Authenticated and the client is Ready.
 */
export async function bridgeTurnkeySessionToNextAuth(
  deps: TurnkeyNextAuthBridgeDeps,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const {
    getSession,
    refreshUser,
    refreshWallets,
    wallets,
    user,
  } = deps;

  await refreshUser();
  const refreshedWallets = await refreshWallets();
  const session = await getSession();
  if (!session?.token) {
    return { ok: false, error: "Could not get session token" };
  }

  const walletAddress = firstEvmAddressFromWallets(
    refreshedWallets?.length ? refreshedWallets : wallets,
  );
  const email = user?.userEmail?.trim() || undefined;
  const name = user?.userName?.trim() || undefined;

  const result = await signIn("turnkey-wallet", {
    turnkeySessionJwt: session.token,
    walletAddress: walletAddress || "",
    email: email || "",
    name: name || "",
    redirect: false,
  });

  if (result?.error) {
    return { ok: false, error: `Authentication failed (${result.error})` };
  }
  if (result?.ok) {
    return { ok: true };
  }
  return { ok: false, error: "Authentication failed — no session created" };
}

/** Safe relative callback path for post-login redirects. */
export function safeCallbackUrl(
  raw: string | null | undefined,
  fallback = "/apps",
): string {
  if (!raw) return fallback;
  return raw.startsWith("/") && !raw.startsWith("//") ? raw : fallback;
}
