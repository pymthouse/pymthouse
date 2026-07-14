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
import { useCallback, useState } from "react";
import { formatUsdMicrosString } from "@/lib/format-usd-micros";

type FundAccountOnRampPanelProps = Readonly<{
  clientId: string;
  ownerExternalUserId: string;
}>;

type FundPhase = "idle" | "funding" | "settling" | "done" | "error";

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
    "noopener=no",
    "noreferrer=no",
  ].join(",");
  // Named window reuses the same popup; open about:blank first so the click
  // gesture is not lost while we await Turnkey init.
  const checkoutWindow = window.open("about:blank", "pymthouse_moonpay", features);
  if (checkoutWindow) {
    try {
      checkoutWindow.document.write("Preparing MoonPay checkout…");
    } catch {
      // Cross-origin / restricted document access is fine.
    }
  }
  return checkoutWindow;
}

const POLL_INTERVAL_MS = 3000;
/** MoonPay sandbox rejects ≤ $20; default past that floor. */
const DEFAULT_FIAT_AMOUNT = "25";

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

  const busy = phase === "funding" || phase === "settling";

  const pollUntilTerminal = useCallback(
    async (transactionId: string, organizationId: string): Promise<string> => {
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

    const amount = DEFAULT_FIAT_AMOUNT;
    const checkoutWindow = openMoonPayCheckoutWindow();

    setPhase("funding");
    setStatusMessage("Preparing MoonPay checkout…");

    try {
      let walletAddress = firstEvmWalletAddress(wallets);
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
        setStatusMessage("Complete the purchase in the MoonPay window…");
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
      setStatusMessage("Purchase completed. Crediting your account…");

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
      setStatusMessage("Prepaid credits updated.");
      setCheckoutUrl(null);
      // Refresh Billing server components (AllowanceStrip / empty state).
      router.refresh();
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
