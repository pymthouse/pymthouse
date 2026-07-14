"use client";

import ApiKeyCredentialSwitcher from "@/components/apps/ApiKeyCredentialSwitcher";
import type { OwnerApiKeyMintState } from "@/components/apps/use-owner-api-key-mint";

type BannerApp = {
  id: string;
  clientId: string | null;
  name: string;
  ownerExternalUserId: string | null;
};

type BannerState<TApp extends BannerApp> =
  | Extract<OwnerApiKeyMintState<TApp>, { phase: "success" }>
  | Extract<OwnerApiKeyMintState<TApp>, { phase: "error" }>;

type OwnerApiKeyMintBannerProps<TApp extends BannerApp> = Readonly<{
  mintState: BannerState<TApp> | null;
  onClose: () => void;
  onRetry: (app: TApp) => void;
}>;

function maskApiKey(apiKey: unknown): unknown {
  if (typeof apiKey !== "string" || apiKey.length <= 24) return apiKey;
  return `${apiKey.slice(0, 12)}…${apiKey.slice(-8)}`;
}

/**
 * Inline notification for a freshly minted owner API key — same visual language
 * as the "New client secret" banner in app settings (no modal).
 */
export default function OwnerApiKeyMintBanner<TApp extends BannerApp>({
  mintState,
  onClose,
  onRetry,
}: OwnerApiKeyMintBannerProps<TApp>) {
  if (!mintState) return null;

  if (mintState.phase === "error") {
    return (
      <div
        role="alert"
        className="rounded-lg border border-red-500/30 bg-red-500/10 p-3"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-red-300">
              Failed to get API key for {mintState.app.name}
            </p>
            <p className="text-xs text-red-200/80 mt-1">{mintState.message}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => onRetry(mintState.app)}
              className="rounded-md border border-red-500/40 px-2.5 py-1 text-xs font-medium text-red-200 hover:bg-red-500/20 transition-colors"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center gap-1 rounded-md border border-red-500/40 px-2 py-1 text-xs font-medium text-red-200 hover:bg-red-500/20 transition-colors"
              aria-label="Clear error from screen"
            >
              <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <output className="block rounded-lg border border-sky-500/30 bg-sky-500/10 p-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-sky-200">
            API Key
          </p>
          <p className="text-[11px] text-amber-300 mt-0.5">
            Store this securely — it will not be shown again.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 inline-flex items-center gap-1 rounded-md border border-sky-500/40 bg-sky-500/10 px-2 py-1 text-xs font-medium text-sky-100 hover:bg-sky-500/20 transition-colors"
          aria-label="Clear API key from screen"
        >
          <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
          Close
        </button>
      </div>

      <ApiKeyCredentialSwitcher
        apiKey={mintState.apiKey}
        sdkToken={mintState.sdkToken}
      />

      <details className="text-[11px] text-sky-300/70">
        <summary className="cursor-pointer hover:text-sky-200">Show more details</summary>
        <p className="mt-1.5 text-sky-300/60">
          Bound to owner identity:{" "}
          <span className="font-mono text-sky-200/80">
            {mintState.app.ownerExternalUserId ?? "—"}
          </span>
        </p>
        <pre className="mt-2 overflow-x-auto rounded-md border border-sky-500/15 bg-black/30 p-2 font-mono text-[10px] text-sky-200/70">
          {JSON.stringify(
            {
              ...mintState.response,
              apiKey: maskApiKey(mintState.response.apiKey),
              ...(typeof mintState.response.sdkToken === "string"
                ? { sdkToken: maskApiKey(mintState.response.sdkToken) }
                : {}),
            },
            null,
            2,
          )}
        </pre>
      </details>
    </output>
  );
}
