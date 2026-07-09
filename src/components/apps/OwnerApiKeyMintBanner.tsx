"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

function CopyApiKeyButton({ apiKey }: Readonly<{ apiKey: string }>) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
    };
  }, []);

  const copy = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      setCopyFailed(true);
      timeoutRef.current = setTimeout(() => {
        timeoutRef.current = null;
        setCopyFailed(false);
      }, 2000);
      return;
    }
    void navigator.clipboard.writeText(apiKey).then(
      () => {
        setCopied(true);
        timeoutRef.current = setTimeout(() => {
          timeoutRef.current = null;
          setCopied(false);
        }, 2000);
      },
      () => {
        setCopyFailed(true);
        timeoutRef.current = setTimeout(() => {
          timeoutRef.current = null;
          setCopyFailed(false);
        }, 2000);
      },
    );
  }, [apiKey]);

  let buttonLabel = "Copy";
  if (copied) buttonLabel = "Copied";
  else if (copyFailed) buttonLabel = "Copy failed";

  return (
    <button
      type="button"
      onClick={copy}
      className="shrink-0 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-200 hover:bg-amber-500/20 transition-colors"
    >
      {buttonLabel}
    </button>
  );
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
    <div
      role="status"
      className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 space-y-2"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-amber-200">
            API key for {mintState.app.name}
          </p>
          <p className="text-[11px] text-amber-300/80 mt-0.5">
            Store this securely — it will not be shown again.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-100 hover:bg-amber-500/20 transition-colors"
          aria-label="Clear API key from screen"
        >
          <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
          Close
        </button>
      </div>

      <div className="flex items-start gap-2 rounded-md border border-amber-500/20 bg-black/30 p-2.5">
        <code className="min-w-0 flex-1 break-all font-mono text-xs text-amber-100 leading-relaxed">
          {mintState.apiKey}
        </code>
        <CopyApiKeyButton apiKey={mintState.apiKey} />
      </div>

      <details className="text-[11px] text-amber-300/70">
        <summary className="cursor-pointer hover:text-amber-200">Show more details</summary>
        <p className="mt-1.5 text-amber-300/60">
          Bound to owner identity:{" "}
          <span className="font-mono text-amber-200/80">
            {mintState.app.ownerExternalUserId ?? "—"}
          </span>
        </p>
        <pre className="mt-2 overflow-x-auto rounded-md border border-amber-500/15 bg-black/30 p-2 font-mono text-[10px] text-amber-200/70">
          {JSON.stringify(
            {
              ...mintState.response,
              apiKey: maskApiKey(mintState.response.apiKey),
            },
            null,
            2,
          )}
        </pre>
      </details>
    </div>
  );
}
