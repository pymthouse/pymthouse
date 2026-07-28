"use client";

import { useCallback, useRef, useState } from "react";

export type MintPhase =
  | { phase: "idle" }
  | { phase: "minting" }
  | {
      phase: "success";
      apiKey: string;
      sdkToken: string | null;
      clientId: string | null;
      externalUserId: string | null;
    }
  | { phase: "error"; message: string };

/**
 * Mint a personal network access key on the platform default app
 * via POST /api/v1/network/key. The endpoint resolves the default
 * app and user identity from the session server-side.
 */
export function useNetworkKeyMint() {
  const [mint, setMint] = useState<MintPhase>({ phase: "idle" });
  const mintingRef = useRef(false);

  const mintKey = useCallback(async () => {
    if (mintingRef.current) return;
    mintingRef.current = true;
    setMint({ phase: "minting" });
    try {
      const res = await fetch("/api/v1/network/key", {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const message = [
          data.error_description,
          data.error,
          `Request failed (${res.status})`,
        ].find((v): v is string => typeof v === "string" && v.trim().length > 0);
        throw new Error(message ?? "Failed to mint API key.");
      }
      const apiKey =
        typeof data.apiKey === "string" && data.apiKey.trim()
          ? data.apiKey.trim()
          : null;
      if (!apiKey) throw new Error("API key mint response missing apiKey.");
      const sdkToken =
        typeof data.sdkToken === "string" && data.sdkToken.trim()
          ? data.sdkToken.trim()
          : null;
      setMint({
        phase: "success",
        apiKey,
        sdkToken,
        clientId: typeof data.clientId === "string" ? data.clientId : null,
        externalUserId:
          typeof data.externalUserId === "string" ? data.externalUserId : null,
      });
    } catch (err) {
      setMint({
        phase: "error",
        message: err instanceof Error ? err.message : "Failed to mint API key.",
      });
    } finally {
      mintingRef.current = false;
    }
  }, []);

  const resetMint = useCallback(() => setMint({ phase: "idle" }), []);

  return { mint, mintKey, resetMint };
}
