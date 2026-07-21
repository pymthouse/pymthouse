"use client";

import {
  AuthState,
  ClientState,
  useTurnkey,
} from "@turnkey/react-wallet-kit";
import {
  FiatOnRampBlockchainNetwork,
  FiatOnRampCryptoCurrency,
  FiatOnRampCurrency,
  FiatOnRampProvider,
} from "@turnkey/sdk-types";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatUsdMicrosString } from "@/lib/format-usd-micros";
import { SANDBOX_ONRAMP_USD_AMOUNT } from "@/lib/onramp/amount";

type FundAccountOnRampPanelProps = Readonly<{
  clientId: string;
  ownerExternalUserId: string;
}>;

type FundPhase = "idle" | "funding" | "settling" | "done" | "error";

type TurnkeyHttpClient = NonNullable<
  ReturnType<typeof useTurnkey>["httpClient"]
>;

function firstEvmWalletAddress(
  wallets: { accounts: { address: string }[] }[],
): string | null {
  for (const wallet of wallets) {
    for (const account of wallet.accounts) {
      const address = account.address;
      if (typeof address === "string" && address.startsWith("0x")) {
        return address;
      }
    }
  }
  return null;
}

function assertSafeOnRampUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Turnkey returned an invalid on-ramp URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("On-ramp URL must use HTTPS.");
  }
  const host = parsed.hostname.toLowerCase();
  const allowed =
    host === "buy.moonpay.com" ||
    host === "buy-sandbox.moonpay.com" ||
    host.endsWith(".moonpay.com") ||
    host === "pay.coinbase.com" ||
    host.endsWith(".coinbase.com");
  if (!allowed) {
    throw new Error(`Blocked unexpected on-ramp host: ${host}`);
  }
  return parsed.toString();
}

function writeCheckoutPlaceholder(checkoutWindow: Window): void {
  try {
    checkoutWindow.document.open();
    checkoutWindow.document.close();
    checkoutWindow.document.body.textContent = "Preparing MoonPay checkout…";
  } catch {
    // Cross-origin / restricted document access is fine.
  }
}

/** Centered popup window (not a full browser tab). */
function openMoonPayCheckoutWindow(): Window | null {
  const width = 480;
  const height = 740;
  const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - width) / 2));
  const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - height) / 2));
  const features = [
    "popup=yes",
    `width=${width}`,
    `height=${height}`,
    `left=${left}`,
    `top=${top}`,
  ].join(",");
  // Named window reuses the same popup; open about:blank first so the click
  // gesture is not lost while we await Turnkey init.
  const checkoutWindow = window.open("about:blank", "pymthouse_moonpay", features);
  if (checkoutWindow) {
    // Sever opener while still same-origin so MoonPay cannot reach the parent.
    checkoutWindow.opener = null;
    writeCheckoutPlaceholder(checkoutWindow);
  }
  return checkoutWindow;
}

function closeCheckoutWindow(checkoutWindow: Window | null): void {
  try {
    checkoutWindow?.close();
  } catch {
    // Best-effort close.
  }
}

async function resolveDepositWallet(input: {
  wallets: { accounts: { address: string }[] }[];
  refreshWallets: () => Promise<{ accounts: { address: string }[] }[]>;
}): Promise<string> {
  let walletAddress = firstEvmWalletAddress(input.wallets);
  if (!walletAddress) {
    try {
      walletAddress = firstEvmWalletAddress(await input.refreshWallets());
    } catch {
      // Keep going with whatever we already have from session state.
    }
  }
  if (!walletAddress) {
    throw new Error("No Turnkey EVM wallet found. Complete Wallet Kit onboarding first.");
  }
  return walletAddress;
}

async function registerOnRampSession(input: {
  clientId: string;
  ownerExternalUserId: string;
  walletAddress: string;
  onRampTransactionId: string;
  organizationId: string;
  amount: string;
}): Promise<string> {
  const sessionResponse = await fetch(
    `/api/v1/apps/${encodeURIComponent(input.clientId)}/onramp/sessions`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        externalUserId: input.ownerExternalUserId,
        depositWalletAddress: input.walletAddress,
        onRampTransactionId: input.onRampTransactionId,
        turnkeyOrganizationId: input.organizationId,
        onrampProvider: "moonpay",
        fiatCurrencyCode: "USD",
        fiatAmount: input.amount,
      }),
    },
  );
  const sessionBody = await sessionResponse.json().catch(() => ({}));
  if (!sessionResponse.ok) {
    throw new Error(
      typeof sessionBody.error === "string"
        ? sessionBody.error
        : "Failed to register on-ramp session",
    );
  }
  const sessionId =
    typeof sessionBody.sessionId === "string" ? sessionBody.sessionId : null;
  if (!sessionId) {
    throw new Error("On-ramp session response missing sessionId.");
  }
  return sessionId;
}

async function settleOnRampPurchase(input: {
  clientId: string;
  sessionId: string;
}): Promise<string | null> {
  const settleResponse = await fetch(
    `/api/v1/apps/${encodeURIComponent(input.clientId)}/onramp/sessions/${encodeURIComponent(input.sessionId)}/settle`,
    {
      method: "POST",
      credentials: "include",
    },
  );
  const settleBody = await settleResponse.json().catch(() => ({}));
  if (!settleResponse.ok) {
    throw new Error(
      typeof settleBody.error === "string" ? settleBody.error : "Settlement failed",
    );
  }
  return typeof settleBody.grantedUsdMicros === "string"
    ? settleBody.grantedUsdMicros
    : null;
}

const POLL_INTERVAL_MS = 3000;
/** Stop waiting for a stuck Turnkey status after this long. */
const POLL_DEADLINE_MS = 15 * 60 * 1000;

function fundingPrerequisiteError(input: {
  turnkeyConfigured: boolean;
  authState: AuthState | undefined;
  clientState: ClientState | undefined;
  httpClient: TurnkeyHttpClient | null | undefined;
}): string | null {
  if (!input.turnkeyConfigured) {
    return "Turnkey Wallet Kit is not configured in this environment.";
  }
  if (
    input.authState !== AuthState.Authenticated ||
    input.clientState !== ClientState.Ready
  ) {
    return "Sign in with Turnkey Wallet Kit to fund your account.";
  }
  if (!input.httpClient) {
    return "Turnkey client is not ready. Refresh and try again.";
  }
  return null;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Polling aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Polling aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export default function FundAccountOnRampPanel({
  clientId,
  ownerExternalUserId,
}: FundAccountOnRampPanelProps) {
  const router = useRouter();
  const turnkeyConfigured =
    !!process.env.NEXT_PUBLIC_ORGANIZATION_ID?.trim() &&
    !!process.env.NEXT_PUBLIC_AUTH_PROXY_CONFIG_ID?.trim();

  const {
    authState,
    clientState,
    wallets,
    refreshWallets,
    httpClient,
    getSession,
  } = useTurnkey();

  const [phase, setPhase] = useState<FundPhase>("idle");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastGrantedUsdMicros, setLastGrantedUsdMicros] = useState<string | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const pollAbortRef = useRef<AbortController | null>(null);

  const busy = phase === "funding" || phase === "settling";

  useEffect(() => {
    return () => {
      pollAbortRef.current?.abort();
    };
  }, []);

  const pollUntilTerminal = useCallback(
    async (
      client: TurnkeyHttpClient,
      transactionId: string,
      organizationId: string,
      signal: AbortSignal,
    ): Promise<string> => {
      const deadline = Date.now() + POLL_DEADLINE_MS;
      for (;;) {
        if (signal.aborted) {
          throw new DOMException("Polling aborted", "AbortError");
        }
        if (Date.now() > deadline) {
          throw new Error("Timed out waiting for MoonPay purchase status.");
        }
        const response = await client.getOnRampTransactionStatus({
          organizationId,
          transactionId,
          refresh: true,
        });
        const status = response.transactionStatus?.trim() || "";
        if (["COMPLETED", "FAILED", "CANCELLED"].includes(status)) {
          return status;
        }
        await delay(POLL_INTERVAL_MS, signal);
      }
    },
    [],
  );

  const handleFund = async () => {
    setError(null);
    setStatusMessage(null);
    setLastGrantedUsdMicros(null);
    setCheckoutUrl(null);

    const prereqError = fundingPrerequisiteError({
      turnkeyConfigured,
      authState,
      clientState,
      httpClient,
    });
    if (prereqError || !httpClient) {
      setError(prereqError ?? "Turnkey client is not ready. Refresh and try again.");
      setPhase("error");
      return;
    }
    const turnkeyClient = httpClient;

    pollAbortRef.current?.abort();
    const pollAbort = new AbortController();
    pollAbortRef.current = pollAbort;

    const amount = SANDBOX_ONRAMP_USD_AMOUNT;
    const checkoutWindow = openMoonPayCheckoutWindow();
    setPhase("funding");
    setStatusMessage("Preparing MoonPay checkout…");

    try {
      const walletAddress = await resolveDepositWallet({ wallets, refreshWallets });
      const session = await getSession();
      const organizationId = session?.organizationId;
      if (!organizationId) {
        throw new Error("Turnkey session is missing organization context.");
      }

      const initResult = await turnkeyClient.initFiatOnRamp({
        organizationId,
        onrampProvider: FiatOnRampProvider.MOONPAY,
        walletAddress,
        network: FiatOnRampBlockchainNetwork.ETHEREUM,
        cryptoCurrencyCode: FiatOnRampCryptoCurrency.ETHEREUM,
        fiatCurrencyCode: FiatOnRampCurrency.USD,
        fiatCurrencyAmount: amount,
        sandboxMode: true,
      });
      if (!initResult.onRampUrl || !initResult.onRampTransactionId) {
        throw new Error("Turnkey did not return an on-ramp URL or transaction id.");
      }

      const onRampUrl = assertSafeOnRampUrl(initResult.onRampUrl);
      setCheckoutUrl(onRampUrl);

      const sessionId = await registerOnRampSession({
        clientId,
        ownerExternalUserId,
        walletAddress,
        onRampTransactionId: initResult.onRampTransactionId,
        organizationId,
        amount,
      });

      if (checkoutWindow && !checkoutWindow.closed) {
        checkoutWindow.location.href = onRampUrl;
        setStatusMessage("Complete the purchase in the MoonPay window…");
      } else {
        setStatusMessage(
          "Checkout ready — open the MoonPay link below, then wait here for confirmation.",
        );
      }

      const terminalStatus = await pollUntilTerminal(
        turnkeyClient,
        initResult.onRampTransactionId,
        organizationId,
        pollAbort.signal,
      );
      closeCheckoutWindow(checkoutWindow);
      if (terminalStatus !== "COMPLETED") {
        throw new Error(`MoonPay purchase ${terminalStatus.toLowerCase()}.`);
      }

      setPhase("settling");
      setStatusMessage("Purchase completed. Crediting your account…");
      const granted = await settleOnRampPurchase({ clientId, sessionId });
      setLastGrantedUsdMicros(granted);
      setPhase("done");
      setStatusMessage("Prepaid credits updated.");
      setCheckoutUrl(null);
      router.refresh();
    } catch (fundError) {
      closeCheckoutWindow(checkoutWindow);
      if (fundError instanceof DOMException && fundError.name === "AbortError") {
        setError("Funding cancelled.");
      } else {
        setError(fundError instanceof Error ? fundError.message : "On-ramp funding failed");
      }
      setPhase("error");
      setStatusMessage(null);
    } finally {
      if (pollAbortRef.current === pollAbort) {
        pollAbortRef.current = null;
      }
    }
  };

  if (!turnkeyConfigured) {
    return null;
  }

  const grantedLabel = formatUsdMicrosString(lastGrantedUsdMicros, 4);

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center justify-end gap-3">
        <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-300">
          Sandbox
        </span>
        <button
          type="button"
          onClick={() => void handleFund()}
          disabled={busy}
          className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? "Processing…" : "Fund with MoonPay"}
        </button>
      </div>
      {statusMessage ? (
        <p className="max-w-xs text-right text-xs text-emerald-200/90">{statusMessage}</p>
      ) : null}
      {checkoutUrl && phase === "funding" ? (
        <p className="max-w-xs text-right text-xs text-zinc-400">
          <a
            href={checkoutUrl}
            target="pymthouse_moonpay"
            rel="noopener noreferrer"
            className="font-medium text-emerald-300 underline underline-offset-2 hover:text-emerald-200"
          >
            Open MoonPay window
          </a>
          {" · "}waiting for confirmation
        </p>
      ) : null}
      {grantedLabel ? (
        <p className="text-xs text-emerald-300">Credited {grantedLabel} to your account</p>
      ) : null}
      {error ? <p className="max-w-xs text-right text-xs text-red-400">{error}</p> : null}
    </div>
  );
}
