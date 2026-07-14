"use client";

import { useCallback, useRef, useState } from "react";
import { mintOwnerApiKey } from "@/components/apps/mint-owner-api-key";

type MintableApp = {
  id: string;
  clientId: string | null;
  ownerExternalUserId: string | null;
};

export type OwnerApiKeyMintState<TApp extends MintableApp> =
  | { phase: "minting"; appId: string }
  | {
      phase: "success";
      app: TApp;
      apiKey: string;
      sdkToken: string | null;
      response: Record<string, unknown>;
    }
  | { phase: "error"; app: TApp; message: string };

export function useOwnerApiKeyMint<TApp extends MintableApp>() {
  const [mintState, setMintState] = useState<OwnerApiKeyMintState<TApp> | null>(
    null,
  );
  const isMintingRef = useRef(false);

  const handleGetApiKey = useCallback((app: TApp) => {
    if (!app.clientId || !app.ownerExternalUserId || isMintingRef.current) return;

    isMintingRef.current = true;
    setMintState({ phase: "minting", appId: app.id });
    mintOwnerApiKey({
      clientId: app.clientId,
      ownerExternalUserId: app.ownerExternalUserId,
    })
      .then((data) => {
        const apiKey =
          typeof data.apiKey === "string" && data.apiKey.trim()
            ? data.apiKey.trim()
            : null;
        if (!apiKey) throw new Error("API key mint response missing apiKey.");
        const sdkToken =
          typeof data.sdkToken === "string" && data.sdkToken.trim()
            ? data.sdkToken.trim()
            : null;
        setMintState({ phase: "success", app, apiKey, sdkToken, response: data });
      })
      .catch((err) => {
        const message =
          err instanceof Error ? err.message : "Failed to mint API key.";
        setMintState({ phase: "error", app, message });
      })
      .finally(() => {
        isMintingRef.current = false;
      });
  }, []);

  return {
    mintState,
    handleGetApiKey,
    closeMintDialog: () => setMintState(null),
  };
}
