"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  deleteDeveloperApp,
  revertDeveloperAppToDraft,
  saveDeveloperApp,
  saveDeveloperAppSettings,
  submitDeveloperAppForReview,
} from "@/domains/developer-apps/ui/app-editor-api";
import {
  createSettingsFormData,
  type AppFormData,
  type AppState,
} from "@/domains/developer-apps/ui/app-editor";
import AppDangerZoneSection from "./settings/AppDangerZoneSection";
import AppSettingsSaveBar from "./settings/AppSettingsSaveBar";
import AppSettingsStatusSection from "./settings/AppSettingsStatusSection";
import PostLogoutRedirectsSection from "./settings/PostLogoutRedirectsSection";
import AppInfoStep from "./steps/AppInfoStep";
import AppModeStep from "./steps/AppModeStep";
import TestingStep from "./steps/TestingStep";

interface Props {
  appId: string;
  initialData: Partial<AppFormData>;
  initialState: AppState;
  initialDomains: { id: string; domain: string }[];
  /** Post-logout URIs and initiate-login URI (OIDC client metadata). */
  initialPostLogoutRedirectUris?: string[];
  initialInitiateLoginUri?: string | null;
  initialDeviceThirdPartyInitiateLogin?: boolean;
  /** When false, settings are view-only (non-admin team members). */
  canEdit?: boolean;
  /** Only the app owner may submit for review (matches submit API). */
  canSubmitForReview?: boolean;
  /** Called after a successful submit so the parent can refresh status UI. */
  onReviewSubmitted?: () => void;
  /** Called after reverting from submitted to draft (header badge, etc.). */
  onRevertedToDraft?: () => void;
}

export default function AppSettingsScreen({
  appId,
  initialData,
  initialState,
  initialDomains,
  initialPostLogoutRedirectUris = [],
  initialInitiateLoginUri = null,
  initialDeviceThirdPartyInitiateLogin = false,
  canEdit = true,
  canSubmitForReview = false,
  onReviewSubmitted,
  onRevertedToDraft,
}: Props) {
  const router = useRouter();
  const [formData, setFormData] = useState<AppFormData>(() =>
    createSettingsFormData(
      initialData,
      initialInitiateLoginUri ?? null,
      initialDeviceThirdPartyInitiateLogin,
    ),
  );
  const [appState, setAppState] = useState<AppState>(initialState);
  const [domains, setDomains] = useState<{ id: string; domain: string }[]>(
    initialDomains,
  );
  const [postLogoutRedirectUris, setPostLogoutRedirectUris] = useState<string[]>(
    initialPostLogoutRedirectUris,
  );
  const [newPostLogoutUri, setNewPostLogoutUri] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [submittingForReview, setSubmittingForReview] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [reverting, setReverting] = useState(false);

  const updateFormData = useCallback(
    (updates: Partial<AppFormData>) => {
      setFormData((prev) => ({ ...prev, ...updates }));
    },
    [],
  );

  const saveChanges = useCallback(async () => {
    if (!canEdit) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const putJson = await saveDeveloperApp(appId, formData);

      if (putJson.m2mOidcClient) {
        setAppState((s) => ({
          ...s,
          backendHelper: putJson.m2mOidcClient ?? null,
        }));
      }

      await saveDeveloperAppSettings(appId, {
        postLogoutRedirectUris,
        initiateLoginUri: formData.initiateLoginUri.trim() || null,
        deviceThirdPartyInitiateLogin: formData.deviceThirdPartyInitiateLogin,
        tokenEndpointAuthMethod: formData.tokenEndpointAuthMethod,
      });

      setMessage("All settings saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  }, [
    appId,
    formData,
    postLogoutRedirectUris,
    canEdit,
  ]);

  const submitForReview = useCallback(async () => {
    if (!canSubmitForReview) return;
    setSubmittingForReview(true);
    setError(null);
    setMessage(null);
    try {
      await submitDeveloperAppForReview(appId);
      setAppState((s) => ({ ...s, status: "submitted" }));
      onReviewSubmitted?.();
      setMessage("App submitted for review. An administrator will approve it.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSubmittingForReview(false);
    }
  }, [appId, canSubmitForReview, onReviewSubmitted]);

  const deleteDraftApp = useCallback(async () => {
    if (!canSubmitForReview || appState.status !== "draft") return;
    if (
      !confirm(
        `Delete "${formData.name.trim() || "this app"}"? This permanently removes the draft app and cannot be undone.`,
      )
    ) {
      return;
    }
    setDeleting(true);
    setError(null);
    setMessage(null);
    try {
      await deleteDeveloperApp(appId);
      router.push("/apps");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  }, [appId, appState.status, canSubmitForReview, formData.name, router]);

  const revertToDraft = useCallback(async () => {
    if (!canSubmitForReview || appState.status !== "submitted") return;
    if (
      !confirm(
        "Revert this app to draft? It will leave the review queue until you submit again.",
      )
    ) {
      return;
    }
    setReverting(true);
    setError(null);
    setMessage(null);
    try {
      await revertDeveloperAppToDraft(appId);
      setAppState((s) => ({ ...s, status: "draft" }));
      onRevertedToDraft?.();
      setMessage("App is back in draft. You can edit and submit again when ready.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Revert failed");
    } finally {
      setReverting(false);
    }
  }, [appId, appState.status, canSubmitForReview, onRevertedToDraft]);

  const addPostLogoutUri = () => {
    const trimmed = newPostLogoutUri.trim();
    if (!trimmed || postLogoutRedirectUris.includes(trimmed)) return;
    setPostLogoutRedirectUris((u) => [...u, trimmed]);
    setNewPostLogoutUri("");
  };

  const discoveryUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/.well-known/openid-configuration`
      : "";
  const authorizeUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/v1/oidc/authorize`
      : "";
  const tokenUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/v1/oidc/token`
      : "";
  const canSave = formData.name.trim().length > 0;

  return (
    <div className="max-w-[600px] divide-y divide-zinc-800">
      <AppSettingsStatusSection
        canEdit={canEdit}
        canSubmitForReview={canSubmitForReview}
        appStatus={appState.status}
        submittingForReview={submittingForReview}
        reverting={reverting}
        error={error}
        message={message}
        onSubmitForReview={() => void submitForReview()}
        onRevertToDraft={() => void revertToDraft()}
      />

      {/* App Info */}
      <section className="py-6">
        <AppInfoStep data={formData} onChange={updateFormData} readOnly={!canEdit} />
      </section>

      {/* Auth & Scopes */}
      <section className="py-6">
        <AppModeStep
          data={formData}
          onChange={updateFormData}
          readOnly={!canEdit}
          appId={appId}
          domains={domains}
          onDomainsChange={setDomains}
        />
      </section>

      <PostLogoutRedirectsSection
        canEdit={canEdit}
        newPostLogoutUri={newPostLogoutUri}
        postLogoutRedirectUris={postLogoutRedirectUris}
        onNewUriChange={setNewPostLogoutUri}
        onAddUri={addPostLogoutUri}
        onRemoveUri={(uri) =>
          setPostLogoutRedirectUris((items) => items.filter((item) => item !== uri))
        }
      />

      {/* Credentials & URIs */}
      <section className="py-6">
        <TestingStep
          appId={appId}
          clientId={appState.clientId}
          grantTypes={formData.grantTypes}
          redirectUris={formData.redirectUris}
          allowedScopes={formData.allowedScopes}
          hasSecret={appState.hasSecret}
          backendHelper={appState.backendHelper}
          onSecretGenerated={() => {
            setAppState((s) => ({ ...s, hasSecret: true }));
            updateFormData({ tokenEndpointAuthMethod: "client_secret_post" });
          }}
          onBackendSecretGenerated={() => {
            setAppState((s) => ({
              ...s,
              backendHelper: s.backendHelper
                ? { ...s.backendHelper, hasSecret: true }
                : s.backendHelper,
            }));
          }}
          readOnly={!canEdit}
        />
      </section>

      {/* Reference endpoints */}
      <ReferenceEndpointsSection
        clientId={appState.clientId || ""}
        discoveryUrl={discoveryUrl}
        authorizeUrl={authorizeUrl}
        tokenUrl={tokenUrl}
      />

      <AppDangerZoneSection
        visible={canSubmitForReview && appState.status === "draft"}
        deleting={deleting}
        onDelete={() => void deleteDraftApp()}
      />

      <AppSettingsSaveBar
        canEdit={canEdit}
        saving={saving}
        canSave={canSave}
        onSave={() => void saveChanges()}
      />
    </div>
  );
}

function ReferenceEndpointsSection({
  clientId,
  discoveryUrl,
  authorizeUrl,
  tokenUrl,
}: {
  clientId: string;
  discoveryUrl: string;
  authorizeUrl: string;
  tokenUrl: string;
}) {
  const rows = useMemo(
    () =>
      [
        { key: "client", label: "Client ID", value: clientId, accent: true as const },
        { key: "discovery", label: "OIDC discovery", value: discoveryUrl, accent: false as const },
        { key: "authorize", label: "Authorize", value: authorizeUrl, accent: false as const },
        { key: "token", label: "Token", value: tokenUrl, accent: false as const },
      ] as const,
    [authorizeUrl, clientId, discoveryUrl, tokenUrl],
  );

  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copyResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyResetTimeoutRef.current !== null) {
        clearTimeout(copyResetTimeoutRef.current);
        copyResetTimeoutRef.current = null;
      }
    };
  }, []);

  const copy = useCallback(async (text: string, key: string) => {
    if (!text) return;
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      console.error("Clipboard API is unavailable.");
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      console.error("Failed to copy reference endpoint.", err);
      return;
    }

    setCopiedKey(key);
    if (copyResetTimeoutRef.current !== null) {
      clearTimeout(copyResetTimeoutRef.current);
    }
    copyResetTimeoutRef.current = setTimeout(() => {
      copyResetTimeoutRef.current = null;
      setCopiedKey(null);
    }, 2000);
  }, []);

  return (
    <section className="py-6 space-y-3">
      <h2 className="text-lg font-semibold text-zinc-100">Reference endpoints</h2>
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 divide-y divide-zinc-800/90">
        {rows.map((row) => (
          <div
            key={row.key}
            className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3"
          >
            <span className="text-sm text-zinc-400 shrink-0 sm:w-36">{row.label}</span>
            <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
              <code
                className={`min-w-0 flex-1 text-xs font-mono leading-snug break-all ${
                  row.accent ? "text-emerald-400" : "text-zinc-300"
                }`}
              >
                {row.value || "—"}
              </code>
              {row.value ? (
                <button
                  type="button"
                  onClick={() => void copy(row.value, row.key)}
                  className="shrink-0 rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-xs font-medium text-zinc-200 hover:bg-zinc-700 transition-colors"
                >
                  {copiedKey === row.key ? "Copied!" : "Copy"}
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
