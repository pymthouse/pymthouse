"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export type ApiKeyDisplayFormat = "bearer" | "token";

function CopyValueButton({
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

function FormatSlider({
  value,
  onChange,
}: Readonly<{
  value: ApiKeyDisplayFormat;
  onChange: (next: ApiKeyDisplayFormat) => void;
}>) {
  return (
    <fieldset
      aria-label="Credential format"
      className="relative inline-grid grid-cols-2 w-[8.5rem] rounded-md bg-zinc-950 border border-sky-500/50 p-px m-0 min-w-0"
    >
      <div
        className={[
          "pointer-events-none absolute top-px bottom-px w-[calc(50%-1px)] rounded-[5px]",
          "bg-sky-600 shadow-sm shadow-sky-900/40",
          "transition-[left] duration-200 ease-out motion-reduce:transition-none",
          value === "bearer" ? "left-px" : "left-[calc(50%)]",
        ].join(" ")}
        aria-hidden
      />
      {(["bearer", "token"] as const).map((option) => {
        const selected = value === option;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option)}
            className={[
              "relative z-10 py-0.5 text-[10px] font-mono font-medium uppercase tracking-wide",
              "transition-colors duration-200 motion-reduce:transition-none",
              selected ? "text-white" : "text-zinc-400 hover:text-zinc-200",
            ].join(" ")}
          >
            {option === "bearer" ? "Bearer" : "Token"}
          </button>
        );
      })}
    </fieldset>
  );
}

/**
 * Single credential display with an optional Bearer / Token slider.
 * Token is the base64 livepeer-python-sdk `--token`.
 */
export default function ApiKeyCredentialSwitcher({
  apiKey,
  sdkToken,
}: Readonly<{
  apiKey: string;
  sdkToken?: string | null;
}>): ReactNode {
  const [format, setFormat] = useState<ApiKeyDisplayFormat>("bearer");
  const hasToken = Boolean(sdkToken?.trim());
  const showToken = hasToken && format === "token";
  const value = showToken ? sdkToken!.trim() : apiKey;

  return (
    <div className="space-y-2">
      {hasToken ? (
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] text-sky-300/70">
            {showToken ? (
              <>
                <a
                  href="https://github.com/livepeer/livepeer-python-gateway"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-sky-200 underline decoration-sky-500/50 underline-offset-2 hover:text-white hover:decoration-sky-300"
                >
                  Python SDK
                </a>{" "}
                <code className="rounded bg-black/40 px-1 py-0.5 font-mono text-[10px] text-sky-100">
                  --token
                </code>{" "}
                (base64)
              </>
            ) : (
              "Authorization: Bearer key"
            )}
          </p>
          <FormatSlider value={format} onChange={setFormat} />
        </div>
      ) : null}

      <div className="flex items-start gap-2 rounded-md border border-sky-500/20 bg-black/30 p-2.5">
        <code className="min-w-0 flex-1 break-all font-mono text-xs text-sky-100 leading-relaxed">
          {value}
        </code>
        <CopyValueButton
          value={value}
          className="shrink-0 rounded-md border border-sky-500/50 bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-500 transition-colors"
        />
      </div>
    </div>
  );
}
