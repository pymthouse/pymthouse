"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { generateDeveloperAppSecret } from "@/domains/developer-apps/ui/app-editor-api";
import {
  buildAppTestingModel,
  getDefaultRedirectUri,
} from "@/domains/developer-apps/ui/app-testing";
import AuthorizationTestSection from "@/components/apps/testing/AuthorizationTestSection";
import ClientCredentialsQuickstartSection from "@/components/apps/testing/ClientCredentialsQuickstartSection";
import DiscoveryChecklistSection from "@/components/apps/testing/DiscoveryChecklistSection";
import TestingCredentialsSection from "@/components/apps/testing/TestingCredentialsSection";

interface Props {
  appId: string | null;
  clientId: string | null;
  grantTypes: string[];
  redirectUris: string[];
  allowedScopes: string;
  hasSecret: boolean;
  backendHelper: { clientId: string; hasSecret: boolean } | null;
  onSecretGenerated: () => void;
  onBackendSecretGenerated?: () => void;
  readOnly?: boolean;
}

export default function TestingStep({
  appId,
  clientId,
  grantTypes,
  redirectUris,
  allowedScopes,
  hasSecret,
  backendHelper,
  onSecretGenerated,
  onBackendSecretGenerated,
  readOnly = false,
}: Props) {
  const [secret, setSecret] = useState<string | null>(null);
  const [backendSecret, setBackendSecret] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generatingBackend, setGeneratingBackend] = useState(false);
  const [secretFetchError, setSecretFetchError] = useState<string | null>(null);
  const [backendSecretFetchError, setBackendSecretFetchError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [selectedRedirectUri, setSelectedRedirectUri] = useState(() =>
    getDefaultRedirectUri(redirectUris),
  );
  const copyResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = typeof window !== "undefined" ? window.location.origin : "";

  useEffect(() => {
    return () => {
      if (copyResetTimeoutRef.current !== null) {
        clearTimeout(copyResetTimeoutRef.current);
        copyResetTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    setSelectedRedirectUri((current) => {
      if (current && redirectUris.includes(current)) return current;
      return getDefaultRedirectUri(redirectUris);
    });
  }, [redirectUris]);

  const generateSecret = useCallback(async () => {
    if (readOnly || !appId) return;
    setGenerating(true);
    setSecretFetchError(null);
    try {
      setSecret(await generateDeveloperAppSecret(appId));
      onSecretGenerated();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not reach the server. Check your connection and try again.";
      setSecretFetchError(message);
    } finally {
      setGenerating(false);
    }
  }, [appId, onSecretGenerated, readOnly]);

  const generateBackendSecret = useCallback(async () => {
    if (readOnly || !appId) return;
    setGeneratingBackend(true);
    setBackendSecretFetchError(null);
    try {
      setBackendSecret(await generateDeveloperAppSecret(appId));
      onBackendSecretGenerated?.();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not reach the server. Check your connection and try again.";
      setBackendSecretFetchError(message);
    } finally {
      setGeneratingBackend(false);
    }
  }, [appId, onBackendSecretGenerated, readOnly]);

  const copyToClipboard = useCallback(async (text: string, label: string) => {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      setCopyError("Clipboard is unavailable in this browser.");
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      console.error("Failed to copy to clipboard.", err);
      setCopied(null);
      setCopyError("Could not copy to clipboard. Please copy the value manually.");
      return;
    }

    setCopyError(null);
    setCopied(label);
    if (copyResetTimeoutRef.current !== null) {
      clearTimeout(copyResetTimeoutRef.current);
    }
    copyResetTimeoutRef.current = setTimeout(() => {
      copyResetTimeoutRef.current = null;
      setCopied(null);
    }, 2000);
  }, []);

  const redirectUriOptions = useMemo(() => redirectUris, [redirectUris]);
  const testingModel = useMemo(
    () =>
      buildAppTestingModel({
        origin,
        clientId,
        grantTypes,
        redirectUris,
        allowedScopes,
        backendHelper,
        selectedRedirectUri,
      }),
    [allowedScopes, backendHelper, clientId, grantTypes, origin, redirectUris, selectedRedirectUri],
  );

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-zinc-100 mb-1">Credentials & Testing</h2>
        <p className="text-sm text-zinc-500">
          {testingModel.isM2MOnly
            ? "Generate your client secret, then test your M2M token request."
            : "Generate and rotate secrets, try a live authorization request, and copy reference endpoints. Configure redirect URIs and allowed domains under Auth & Scopes → Authorization Code + PKCE."}
        </p>
        {copyError && <p className="text-xs text-red-400 mt-2">{copyError}</p>}
      </div>

      {testingModel.isM2MOnly && (
        <ClientCredentialsQuickstartSection
          clientId={clientId}
          curlSnippet={testingModel.m2mCurlSnippet}
          copiedKey={copied}
          onCopy={(text, label) => void copyToClipboard(text, label)}
        />
      )}

      {testingModel.hasAuthCodeFlow && (
        <AuthorizationTestSection
          redirectUriOptions={redirectUriOptions}
          selectedRedirectUri={selectedRedirectUri}
          selectedScopes={testingModel.selectedScopes}
          testUrl={testingModel.testUrl}
          onRedirectUriChange={setSelectedRedirectUri}
          onOpenTestFlow={() => {
            if (!testingModel.testUrl) return;
            const newWin = window.open(testingModel.testUrl, "_blank", "noopener,noreferrer");
            if (newWin) newWin.opener = null;
          }}
        />
      )}

      <TestingCredentialsSection
        isM2MOnly={testingModel.isM2MOnly}
        clientId={clientId}
        hasSecret={hasSecret}
        secret={secret}
        backendHelper={backendHelper}
        backendSecret={backendSecret}
        backendHelperCurlSnippet={testingModel.backendHelperCurlSnippet}
        copiedKey={copied}
        secretFetchError={secretFetchError}
        backendSecretFetchError={backendSecretFetchError}
        generating={generating}
        generatingBackend={generatingBackend}
        readOnly={readOnly}
        appId={appId}
        onCopy={(text, label) => void copyToClipboard(text, label)}
        onGenerateSecret={() => void generateSecret()}
        onGenerateBackendSecret={() => void generateBackendSecret()}
      />

      <DiscoveryChecklistSection
        discoveryUrl={testingModel.discoveryUrl}
        copiedKey={copied}
        hasAuthCodeFlow={testingModel.hasAuthCodeFlow}
        onCopy={(text, label) => void copyToClipboard(text, label)}
      />
    </div>
  );
}
