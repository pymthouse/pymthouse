"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export default function CopyIdButton({
  value,
  label = "Copy id",
  className = "",
}: Readonly<{
  value: string;
  label?: string;
  /** Merged onto the button (e.g. to control visibility/position within a row). */
  className?: string;
}>) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const copy = useCallback(
    (e: React.MouseEvent) => {
      // Copy buttons are often nested inside a card/row `<Link>`; don't navigate.
      e.preventDefault();
      e.stopPropagation();

      const settle = (ok: boolean) => {
        setCopied(ok);
        setCopyFailed(!ok);
        if (timeoutRef.current !== null) {
          clearTimeout(timeoutRef.current);
        }
        timeoutRef.current = setTimeout(() => {
          timeoutRef.current = null;
          setCopied(false);
          setCopyFailed(false);
        }, 2000);
      };

      if (typeof navigator === "undefined" || !navigator.clipboard) {
        settle(false);
        return;
      }

      void navigator.clipboard.writeText(value).then(
        () => settle(true),
        () => settle(false),
      );
    },
    [value],
  );

  let statusLabel = label;
  if (copied) statusLabel = "Copied";
  else if (copyFailed) statusLabel = "Copy failed";

  return (
    <button
      type="button"
      onClick={copy}
      className={`pointer-events-auto relative z-10 shrink-0 rounded-md border border-zinc-700 bg-zinc-800 p-1.5 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 transition-colors ${className}`}
      aria-label={statusLabel}
      title={statusLabel}
    >
      {copied ? (
        <svg
          className="h-3.5 w-3.5 text-emerald-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M5 13l4 4L19 7"
          />
        </svg>
      ) : (
        <svg
          className="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
          />
        </svg>
      )}
    </button>
  );
}
