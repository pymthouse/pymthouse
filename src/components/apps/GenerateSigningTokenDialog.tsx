"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

type GenerateSigningTokenDialogProps = Readonly<{
  appName: string;
  ownerExternalUserId: string;
  onClose: () => void;
} & (
  | { phase: "success"; apiKey: string; response: Record<string, unknown> }
  | { phase: "error"; message: string; onRetry: () => void }
)>;

function maskApiKey(apiKey: unknown): unknown {
  if (typeof apiKey !== "string" || apiKey.length <= 24) {
    return apiKey;
  }

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
      timeoutRef.current = setTimeout(() => { timeoutRef.current = null; setCopyFailed(false); }, 2000);
      return;
    }
    void navigator.clipboard.writeText(apiKey).then(
      () => {
        setCopied(true);
        timeoutRef.current = setTimeout(() => { timeoutRef.current = null; setCopied(false); }, 2000);
      },
      () => {
        setCopyFailed(true);
        timeoutRef.current = setTimeout(() => { timeoutRef.current = null; setCopyFailed(false); }, 2000);
      },
    );
  }, [apiKey]);

  let buttonLabel = "Copy";
  if (copied) {
    buttonLabel = "Copied";
  } else if (copyFailed) {
    buttonLabel = "Copy failed";
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="shrink-0 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 transition-colors"
    >
      {buttonLabel}
    </button>
  );
}

export default function GenerateSigningTokenDialog(props: GenerateSigningTokenDialogProps) {
  const { appName, ownerExternalUserId, onClose } = props;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/60"
        aria-label="Close dialog"
        onClick={onClose}
      />
      <dialog
        open
        aria-modal="true"
        aria-labelledby="signing-token-dialog-title"
        className="relative z-10 m-0 w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-900 p-6 shadow-xl"
      >
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2
              id="signing-token-dialog-title"
              className="text-base font-semibold text-zinc-100"
            >
              Get API Key
            </h2>
            <p className="text-sm text-zinc-500 mt-1">{appName}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-md p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 transition-colors"
            aria-label="Close"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <p className="text-xs text-zinc-500 mb-4">
          Bound to owner identity:{" "}
          <span className="font-mono text-zinc-400">{ownerExternalUserId}</span>
        </p>

        {props.phase === "error" ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3">
              <p className="text-sm text-red-300">{props.message}</p>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-800 transition-colors"
              >
                Close
              </button>
              <button
                type="button"
                onClick={props.onRetry}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 transition-colors"
              >
                Retry
              </button>
            </div>
          </div>
        ) : null}

        {props.phase === "success" ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
              <p className="text-sm text-amber-200">
                Store this API key securely. It will not be shown again.
              </p>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-4">
              <div className="flex items-start justify-between gap-3">
                <code className="min-w-0 flex-1 break-all font-mono text-xs text-emerald-400 leading-relaxed">
                  {props.apiKey}
                </code>
                <CopyApiKeyButton apiKey={props.apiKey} />
              </div>
            </div>
            <details className="text-xs text-zinc-500">
              <summary className="cursor-pointer hover:text-zinc-400">Response details</summary>
              <pre className="mt-2 overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950/50 p-3 font-mono text-[11px] text-zinc-400">
                {JSON.stringify(
                  {
                    ...props.response,
                    apiKey: maskApiKey(props.response.apiKey),
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        ) : null}
      </dialog>
    </div>
  );
}
