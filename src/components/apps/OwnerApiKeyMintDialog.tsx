"use client";

import GenerateSigningTokenDialog from "@/components/apps/GenerateSigningTokenDialog";
import type { OwnerApiKeyMintState } from "@/components/apps/use-owner-api-key-mint";

type DialogApp = {
  id: string;
  clientId: string | null;
  name: string;
  ownerExternalUserId: string | null;
};

type DialogState<TApp extends DialogApp> =
  | Extract<OwnerApiKeyMintState<TApp>, { phase: "success" }>
  | Extract<OwnerApiKeyMintState<TApp>, { phase: "error" }>;

type OwnerApiKeyMintDialogProps<TApp extends DialogApp> = Readonly<{
  mintState: DialogState<TApp> | null;
  onClose: () => void;
  onRetry: (app: TApp) => void;
}>;

export default function OwnerApiKeyMintDialog<TApp extends DialogApp>({
  mintState,
  onClose,
  onRetry,
}: OwnerApiKeyMintDialogProps<TApp>) {
  if (!mintState) return null;

  if (mintState.phase === "success") {
    return (
      <GenerateSigningTokenDialog
        phase="success"
        appName={mintState.app.name}
        ownerExternalUserId={mintState.app.ownerExternalUserId ?? ""}
        apiKey={mintState.apiKey}
        response={mintState.response}
        onClose={onClose}
      />
    );
  }

  return (
    <GenerateSigningTokenDialog
      phase="error"
      appName={mintState.app.name}
      ownerExternalUserId={mintState.app.ownerExternalUserId ?? ""}
      message={mintState.message}
      onClose={onClose}
      onRetry={() => onRetry(mintState.app)}
    />
  );
}
