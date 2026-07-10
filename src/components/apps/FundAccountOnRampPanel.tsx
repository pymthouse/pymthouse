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
import { useCallback, useEffect, useState } from "react";
import { formatUsdMicrosString } from "@/lib/format-usd-micros";

type FundAccountOnRampPanelProps = Readonly<{
  clientId: string;
  ownerExternalUserId: string;
}>;

type BalanceState = {
  balanceUsdMicros: string;
  hasAccess: boolean;
};

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

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
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

const POLL_INTERVAL_MS = 3000;
const DEFAULT_FIAT_AMOUNT = "25";

export default function FundAccountOnRampPanel({
  clientId,
  ownerExternalUserId,
}: FundAccountOnRampPanelProps) {
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

  const [fiatAmount, setFiatAmount] = useState(DEFAULT_FIAT_AMOUNT);
  const [balance, setBalance] = useState<BalanceState | null>(null);
  const [depositWallet, setDepositWallet] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "funding" | "settling" | "done" | "error">("idle");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastGrantedUsdMicros, setLastGrantedUsdMicros] = useState<string | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);

  const loadBalance = useCallback(async () => {
    const params = new URLSearchParams({ externalUserId: ownerExternalUserId });
    const response = await fetch(
      `/api/v1/apps/${encodeURIComponent(clientId)}/usage/balance?${params.toString()}`,
      { credentials: "include" },
    );
    if (!response.ok) {
      return;
    }
    const data = (await response.json()) as BalanceState;
    setBalance(data);
  }, [clientId, ownerExternalUserId]);

  useEffect(() => {
    void loadBalance();
  }, [loadBalance]);

  useEffect(() => {
    const address = firstEvmWalletAddress(wallets);
    setDepositWallet(address);
  }, [wallets]);

  const pollUntilTerminal = useCallback(
    async (
      transactionId: string,
      organizationId: string,
    ): Promise<string> => {
      if (!httpClient) {
        throw new Error("Turnkey client is not ready.");
      }
      for (;;) {
        const response = await httpClient.getOnRampTransactionStatus({
          organizationId,
          transactionId,
          refresh: true,
        });
        const status = response.transactionStatus?.trim() || "";
        if (["COMPLETED", "FAILED", "CANCELLED"].includes(status)) {
          return status;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    },
    [httpClient],
  );

  const handleFund = async () => {
    setError(null);
    setStatusMessage(null);
    setLastGrantedUsdMicros(null);
    setCheckoutUrl(null);

    if (!turnkeyConfigured) {
      setError("Turnkey Wallet Kit is not configured in this environment.");
      setPhase("error");
      return;
    }

    if (authState !== AuthState.Authenticated || clientState !== ClientState.Ready) {
      setError("Sign in with Turnkey Wallet Kit to fund your account.");
      setPhase("error");
      return;
    }

    if (!httpClient) {
      setError("Turnkey client is not ready. Refresh and try again.");
      setPhase("error");
      return;
    }

    const amount = fiatAmount.trim();
    const parsedAmount = Number.parseFloat(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 20) {
      setError("Enter a fiat amount greater than 20 USD for MoonPay sandbox.");
      setPhase("error");
      return;
    }

    // Open synchronously on click so popup blockers don't treat the later
    // navigation as unsolicited. window.open(..., "noopener") returns null
    // even when the tab opens, so never treat a null handle as "blocked".
    const checkoutWindow = window.open("about:blank", "_blank");
    if (checkoutWindow) {
      try {
        checkoutWindow.document.write("Preparing MoonPay checkout…");
      } catch {
        // Cross-origin / restricted document access is fine.
      }
    }

    setPhase("funding");
    setStatusMessage("Preparing MoonPay sandbox checkout...");

    try {
      // Prefer the address already loaded into Wallet Kit state. refreshWallets()
      // can return wallets with empty accounts even when the hook's `wallets`
      // (and the UI deposit address) are populated from the active session.
      let walletAddress = depositWallet ?? firstEvmWalletAddress(wallets);
      if (!walletAddress) {
        try {
          const latestWallets = await refreshWallets();
          walletAddress = firstEvmWalletAddress(latestWallets);
        } catch {
          // Keep going with whatever we already have from session state.
        }
      }
      if (!walletAddress) {
        throw new Error("No Turnkey EVM wallet found. Complete Wallet Kit onboarding first.");
      }

      const session = await getSession();
      const organizationId = session?.organizationId;
      if (!organizationId) {
        throw new Error("Turnkey session is missing organization context.");
      }

      // Wallet Kit exposes initFiatOnRamp on httpClient, not on useTurnkey() itself.
      // Prefer this over handleOnRamp so we can register the transaction id before settle.
      const initResult = await httpClient.initFiatOnRamp({
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

      const sessionResponse = await fetch(
        `/api/v1/apps/${encodeURIComponent(clientId)}/onramp/sessions`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            externalUserId: ownerExternalUserId,
            depositWalletAddress: walletAddress,
            onRampTransactionId: initResult.onRampTransactionId,
            turnkeyOrganizationId: organizationId,
            onrampProvider: "moonpay",
            fiatCurrencyCode: "USD",
            fiatAmount: amount,
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

      if (checkoutWindow && !checkoutWindow.closed) {
        checkoutWindow.location.href = onRampUrl;
        setStatusMessage("Complete the MoonPay sandbox purchase in the checkout window...");
      } else {
        setStatusMessage(
          "Checkout ready — open the MoonPay link below, then wait here for confirmation.",
        );
      }

      const terminalStatus = await pollUntilTerminal(
        initResult.onRampTransactionId,
        organizationId,
      );
      try {
        checkoutWindow?.close();
      } catch {
        // Best-effort close after terminal status.
      }

      if (terminalStatus !== "COMPLETED") {
        throw new Error(`MoonPay purchase ${terminalStatus.toLowerCase()}.`);
      }

      setPhase("settling");
      setStatusMessage("Purchase completed. Crediting OpenMeter allowance...");

      const settleResponse = await fetch(
        `/api/v1/apps/${encodeURIComponent(clientId)}/onramp/sessions/${encodeURIComponent(sessionId)}/settle`,
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

      const granted =
        typeof settleBody.grantedUsdMicros === "string"
          ? settleBody.grantedUsdMicros
          : null;
      setLastGrantedUsdMicros(granted);
      setPhase("done");
      setStatusMessage("Allowance credited successfully.");
      setCheckoutUrl(null);
      await loadBalance();
    } catch (fundError) {
      try {
        checkoutWindow?.close();
      } catch {
        // ignore
      }
      const message =
        fundError instanceof Error ? fundError.message : "On-ramp funding failed";
      setError(message);
      setPhase("error");
      setStatusMessage(null);
    }
  };

  if (!turnkeyConfigured) {
    return null;
  }

  const balanceLabel = formatUsdMicrosString(balance?.balanceUsdMicros, 4) ?? "$0";
  const grantedLabel = formatUsdMicrosString(lastGrantedUsdMicros, 4);

  return (
    <div className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-amber-200/90">
            Fund account (demo)
          </p>
          <p className="mt-1 text-sm text-zinc-400">
            MoonPay sandbox purchase credits OpenMeter allowance for your app owner identity.
          </p>
        </div>
        <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-200">
          Sandbox
        </span>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
          <p className="text-[11px] uppercase tracking-wider text-zinc-500">Deposit wallet</p>
          <p className="mt-1 font-mono text-sm text-zinc-200">
            {depositWallet ? truncateAddress(depositWallet) : "—"}
          </p>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
          <p className="text-[11px] uppercase tracking-wider text-zinc-500">Allowance balance</p>
          <p className="mt-1 text-sm font-semibold text-zinc-100 tabular-nums">{balanceLabel}</p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-zinc-500">USD amount</span>
          <input
            type="number"
            min={21}
            step="1"
            value={fiatAmount}
            onChange={(event) => setFiatAmount(event.target.value)}
            disabled={phase === "funding" || phase === "settling"}
            className="w-28 rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
          />
        </label>
        <button
          type="button"
          onClick={() => void handleFund()}
          disabled={phase === "funding" || phase === "settling"}
          className="rounded-md bg-amber-500 px-4 py-2 text-sm font-medium text-zinc-950 transition-colors hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {phase === "funding" || phase === "settling"
            ? "Processing..."
            : "Fund with MoonPay"}
        </button>
      </div>

      {statusMessage ? (
        <p className="mt-3 text-sm text-amber-100/90">{statusMessage}</p>
      ) : null}
      {checkoutUrl && phase === "funding" ? (
        <p className="mt-2 text-sm text-zinc-300">
          <a
            href={checkoutUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-amber-300 underline underline-offset-2 hover:text-amber-200"
          >
            Open MoonPay checkout
          </a>
          {" · "}waiting for Turnkey status COMPLETED, then allowance credit.
        </p>
      ) : null}
      {grantedLabel ? (
        <p className="mt-2 text-sm text-emerald-300">
          Credited {grantedLabel} to <span className="font-mono">{ownerExternalUserId}</span>.
        </p>
      ) : null}
      {error ? <p className="mt-3 text-sm text-red-400">{error}</p> : null}

      <p className="mt-3 text-[11px] leading-relaxed text-zinc-500">
        Owner identity: <span className="font-mono text-zinc-400">{ownerExternalUserId}</span>.
        ETH lands in your Turnkey wallet on Ethereum; TicketBroker sweeps are phase 2.
      </p>
    </div>
  );
}
