"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

function CopyButton({
  value,
  className,
}: Readonly<{ value: string; className?: string }>) {
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
    void navigator.clipboard.writeText(value).then(
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
  }, [value]);

  let buttonLabel = "Copy";
  if (copied) buttonLabel = "Copied";
  else if (copyFailed) buttonLabel = "Copy failed";

  return (
    <button type="button" onClick={copy} className={className}>
      {buttonLabel}
    </button>
  );
}

/**
 * Noticeable reveal for the base64 livepeer-python-sdk `--token` returned
 * alongside a freshly minted API key.
 */
export default function SdkTokenReveal({
  sdkToken,
}: Readonly<{ sdkToken: string }>): ReactNode {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-md border border-sky-500/35 bg-sky-500/10 p-2.5 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-sky-200">
            Python SDK token (`--token`)
          </p>
          <p className="text-[11px] text-sky-300/75 mt-0.5">
            Base64 credential for{" "}
            <span className="font-mono text-sky-200/90">livepeer-python-sdk</span>
            . Same one-time secret as the API key above.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          className="shrink-0 rounded-md border border-sky-500/45 bg-sky-500/15 px-2.5 py-1 text-xs font-medium text-sky-100 hover:bg-sky-500/25 transition-colors"
          aria-expanded={open}
        >
          {open ? "Hide SDK token" : "Show SDK token"}
        </button>
      </div>

      {open ? (
        <div className="space-y-2">
          <div className="flex items-start gap-2 rounded-md border border-sky-500/25 bg-black/30 p-2.5">
            <code className="min-w-0 flex-1 break-all font-mono text-xs text-sky-100 leading-relaxed">
              {sdkToken}
            </code>
            <CopyButton
              value={sdkToken}
              className="shrink-0 rounded-md border border-sky-500/45 bg-sky-500/15 px-2.5 py-1 text-xs font-medium text-sky-100 hover:bg-sky-500/25 transition-colors"
            />
          </div>
          <p className="text-[11px] text-sky-300/70">
            Pass as{" "}
            <span className="font-mono text-sky-200/85">--token &lt;value&gt;</span>{" "}
            to the Livepeer Python SDK.
          </p>
        </div>
      ) : null}
    </div>
  );
}
