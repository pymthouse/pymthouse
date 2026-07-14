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

async function bestEffort<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.debug(`Turnkey bridge: ${label} failed (continuing):`, message);
    return undefined;
  }
}

/**
 * Exchange an authenticated Turnkey session for a NextAuth `turnkey-wallet` session.
 * Callers must ensure Turnkey is Authenticated and the client is Ready.
 *
 * The session JWT alone is enough for NextAuth (`user_id` in claims).
 * `refreshUser` / `refreshWallets` are best-effort enrichment — they often throw
 * "Failed to fetch user" right after OTP/OAuth on staging, and a SESSION_EXPIRED
 * path can logout mid-bridge if we refresh before capturing the token.
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

  const session = await getSession();
  const sessionToken = session?.token?.trim();
  if (!sessionToken) {
    return { ok: false, error: "Could not get session token" };
  }

  await bestEffort("refreshUser", () => refreshUser());
  const refreshedWallets = await bestEffort("refreshWallets", () =>
    refreshWallets(),
  );

  const walletAddress = firstEvmAddressFromWallets(
    refreshedWallets?.length ? refreshedWallets : wallets,
  );
  const email = user?.userEmail?.trim() || undefined;
  const name = user?.userName?.trim() || undefined;

  const result = await signIn("turnkey-wallet", {
    turnkeySessionJwt: sessionToken,
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
