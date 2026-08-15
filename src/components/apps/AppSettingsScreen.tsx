"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import AppInfoStep from "./steps/AppInfoStep";
import AppModeStep from "./steps/AppModeStep";
import TestingStep, {
  API_REFERENCE_URL,
  type CredentialsClientTab,
} from "./steps/TestingStep";
import PlansTab from "./PlansTab";
import PaymentsTab from "./PaymentsTab";
import {
  defaultAppFormData,
  type AppFormData,
  type AppState,
} from "./AppWizard";
import {
  normalizeAppSettingsTab,
  type AppSettingsTab,
} from "@/lib/apps/settings-paths";

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
  /** Only the app owner may delete the app. */
  canDeleteApp?: boolean;
  /** Only app owner may connect/disconnect Stripe (matches billing API). */
  canManageBilling?: boolean;
  /** App owner identity used when minting owner-scoped API keys from Credentials tab. */
  ownerExternalUserId?: string | null;
  /** Initial tab to display (from path `/apps/{id}/payments`). */
  initialTab?: string;
}

function mergeFormData(
  initial: Partial<AppFormData>,
  initialInitiateLoginUri: string | null,
  initialDeviceThirdPartyInitiateLogin: boolean,
): AppFormData {
  return {
    ...defaultAppFormData,
    ...initial,
    redirectUris: initial.redirectUris ?? [...defaultAppFormData.redirectUris],
    grantTypes:
      initial.grantTypes !== undefined
        ? [...initial.grantTypes]
        : [...defaultAppFormData.grantTypes],
    allowedScopes: initial.allowedScopes ?? defaultAppFormData.allowedScopes,
    backendDeviceHelper: initial.backendDeviceHelper ?? false,
    confidentialWebHelper: initial.confidentialWebHelper ?? false,
    confidentialWebRedirectUris:
      initial.confidentialWebRedirectUris ??
      [...defaultAppFormData.confidentialWebRedirectUris],
    initiateLoginUri: initial.initiateLoginUri ?? initialInitiateLoginUri ?? "",
    deviceThirdPartyInitiateLogin:
      initial.deviceThirdPartyInitiateLogin ?? initialDeviceThirdPartyInitiateLogin,
  };
}

function resolveInitialTab(tab: string | undefined): AppSettingsTab {
  return normalizeAppSettingsTab(tab);
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
  canDeleteApp = false,
  canManageBilling = false,
  ownerExternalUserId = null,
  initialTab,
}: Readonly<Props>) {
  const router = useRouter();
  const [formData, setFormData] = useState<AppFormData>(() =>
    mergeFormData(initialData, initialInitiateLoginUri ?? null, initialDeviceThirdPartyInitiateLogin),
  );
  const [appState, setAppState] = useState<AppState>(initialState);
  const [domains, setDomains] = useState<{ id: string; domain: string }[]>(
    initialDomains,
  );
  const [postLogoutRedirectUris, setPostLogoutRedirectUris] = useState<string[]>(
    initialPostLogoutRedirectUris,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const messageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const integrationSection = resolveInitialTab(initialTab);

  // Which credential accordion sections are expanded (all open by default)
  const [expandedCredentials, setExpandedCredentials] = useState<Set<CredentialsClientTab>>(
    () => new Set<CredentialsClientTab>(["public", "m2m", "web"]),
  );

  const toggleCredential = useCallback((client: CredentialsClientTab) => {
    setExpandedCredentials((prev) => {
      const next = new Set(prev);
      if (next.has(client)) {
        next.delete(client);
      } else {
        next.add(client);
      }
      return next;
    });
  }, []);

  const showMessage = useCallback((msg: string) => {
    setMessage(msg);
    if (messageTimerRef.current !== null) {
      clearTimeout(messageTimerRef.current);
    }
    messageTimerRef.current = setTimeout(() => {
      messageTimerRef.current = null;
      setMessage(null);
    }, 4000);
  }, []);

  useEffect(() => {
    return () => {
      if (messageTimerRef.current !== null) {
        clearTimeout(messageTimerRef.current);
      }
    };
  }, []);

  const updateFormData = useCallback(
    (updates: Partial<AppFormData>) => {
      setFormData((prev) => ({ ...prev, ...updates }));
      setIsDirty(true);
    },
    [],
  );

  const updatePostLogoutRedirectUris = useCallback(
    (updater: React.SetStateAction<string[]>) => {
      setPostLogoutRedirectUris(updater);
      setIsDirty(true);
    },
    [],
  );

  const markPrimarySecretGenerated = useCallback(() => {
    setAppState((s) => ({ ...s, hasSecret: true }));
    updateFormData({ tokenEndpointAuthMethod: "client_secret_post" });
  }, [updateFormData]);

  const markBackendSecretGenerated = useCallback(() => {
    setAppState((s) => ({
      ...s,
      backendHelper: s.backendHelper
        ? { ...s.backendHelper, hasSecret: true }
        : s.backendHelper,
    }));
  }, []);

  const markWebSecretGenerated = useCallback(() => {
    setAppState((s) => ({
      ...s,
      webHelper: s.webHelper
        ? { ...s.webHelper, hasSecret: true }
        : s.webHelper,
    }));
  }, []);

  const handlePostLogoutRedirectUrisChange = useCallback(
    (uris: string[]) => {
      updatePostLogoutRedirectUris(uris);
    },
    [updatePostLogoutRedirectUris],
  );

  const syncCredentialsFromServer = useCallback(async () => {
    const res = await fetch(`/api/v1/apps/${appId}`);
    if (!res.ok) {
      return;
    }
    const data = (await res.json()) as {
      m2mOidcClient?: { clientId: string; hasSecret: boolean } | null;
      webOidcClient?: {
        clientId: string;
        hasSecret: boolean;
        redirectUris: string[];
        postLogoutRedirectUris?: string[];
      } | null;
      oidcClient?: {
        hasSecret?: boolean;
        clientId?: string;
        postLogoutRedirectUris?: string[];
      } | null;
    };
    setAppState((s) => ({
      ...s,
      backendHelper: data.m2mOidcClient ?? null,
      webHelper: data.webOidcClient ?? null,
      hasSecret: data.oidcClient?.hasSecret ?? s.hasSecret,
      clientId: data.oidcClient?.clientId ?? s.clientId,
    }));
    setFormData((prev) => ({
      ...prev,
      redirectUris: [],
      backendDeviceHelper: Boolean(data.m2mOidcClient),
      confidentialWebHelper: Boolean(data.webOidcClient),
      confidentialWebRedirectUris: data.webOidcClient?.redirectUris ?? [],
    }));
    setPostLogoutRedirectUris(
      data.webOidcClient?.postLogoutRedirectUris ??
        data.oidcClient?.postLogoutRedirectUris ??
        [],
    );
  }, [appId]);

  useEffect(() => {
    if (integrationSection !== "credentials") {
      return;
    }
    void syncCredentialsFromServer();
  }, [integrationSection, syncCredentialsFromServer]);

  const saveChanges = useCallback(async () => {
    if (!canEdit) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/v1/apps/${appId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...formData, redirectUris: [] }),
      });
      const putJson = (await res.json()) as {
        success?: boolean;
        m2mOidcClient?: { clientId: string; hasSecret: boolean } | null;
        webOidcClient?: {
          clientId: string;
          hasSecret: boolean;
          redirectUris: string[];
        } | null;
        error?: string;
        error_description?: string;
      };
      if (!res.ok) {
        throw new Error(
          putJson.error_description || putJson.error || `Failed to save (${res.status})`,
        );
      }

      setAppState((s) => ({
        ...s,
        backendHelper: putJson.m2mOidcClient ?? null,
        webHelper: putJson.webOidcClient ?? null,
      }));
      setFormData((prev) => ({
        ...prev,
        backendDeviceHelper: Boolean(putJson.m2mOidcClient),
        confidentialWebHelper: Boolean(putJson.webOidcClient),
        confidentialWebRedirectUris: putJson.webOidcClient?.redirectUris ?? [],
      }));

      const settingsRes = await fetch(`/api/v1/apps/${appId}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          postLogoutRedirectUris,
          initiateLoginUri: formData.initiateLoginUri.trim() || null,
          deviceThirdPartyInitiateLogin: formData.deviceThirdPartyInitiateLogin,
          tokenEndpointAuthMethod: formData.tokenEndpointAuthMethod,
        }),
      });
      if (!settingsRes.ok) {
        const body = await settingsRes.json().catch(() => ({}));
        throw new Error(
          body.error || "App metadata saved, but failed to save OIDC settings"
        );
      }

      setIsDirty(false);
      showMessage("All settings saved.");
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
    showMessage,
  ]);

  const deleteApp = useCallback(async () => {
    if (!canDeleteApp) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/apps/${appId}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          typeof body.error === "string"
            ? body.error
            : `Delete failed (${res.status})`,
        );
      }
      router.push("/apps");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  }, [appId, canDeleteApp, router]);

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
  const signerSessionUrl =
    typeof window !== "undefined" && appState.clientId
      ? `${window.location.origin}/api/v1/apps/${encodeURIComponent(appState.clientId)}/oidc/token`
      : "";
  const showPostLogoutRedirectUris =
    Boolean(formData.confidentialWebHelper) || Boolean(appState.webHelper);

  const showM2mCredentialsTab =
    Boolean(formData.backendDeviceHelper) || Boolean(appState.backendHelper);
  const showWebCredentialsTab =
    Boolean(formData.confidentialWebHelper) || Boolean(appState.webHelper);

  const credentialsTestingStep = {
    appId,
    appState,
    formData,
    domains,
    onChange: updateFormData,
    onDomainsChange: setDomains,
    onSecretGenerated: markPrimarySecretGenerated,
    onBackendSecretGenerated: markBackendSecretGenerated,
    onWebSecretGenerated: markWebSecretGenerated,
    ownerExternalUserId,
    readOnly: !canEdit,
    postLogoutRedirectUris,
    onPostLogoutRedirectUrisChange: handlePostLogoutRedirectUrisChange,
    showPostLogoutRedirectUris,
  };

  return (
    <div className="max-w-3xl">
      {/* Status banners */}
      <div className="space-y-3 pb-6">
        {!canEdit && (
          <div className="p-3 rounded-md bg-amber-500/10 border border-amber-500/25 text-amber-200 text-sm">
            You can view this app&apos;s configuration. Only platform or app
            administrators can change settings.
          </div>
        )}
        {error && (
          <div className="p-3 rounded-md bg-red-500/10 border border-red-500/20 text-red-300 text-sm">
            {error}
          </div>
        )}
        {message && (
          <div className="p-3 rounded-md bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-sm">
            {message}
          </div>
        )}
      </div>

      {integrationSection === "profile" && (
        <div
          id="panel-profile"
          role="tabpanel"
          aria-labelledby="tab-profile"
          className="space-y-10 pb-6"
        >
          <section className="space-y-4">
            <AppInfoStep data={formData} onChange={updateFormData} readOnly={!canEdit} />
          </section>

          <AppModeStep
            data={formData}
            onChange={updateFormData}
            readOnly={!canEdit}
          />

          {canDeleteApp && (
            <section className="space-y-3 pt-2 border-t border-zinc-800">
              <h2 className="text-sm font-semibold text-zinc-100">Delete app</h2>
              <p className="text-sm text-zinc-400">
                Permanently remove this app, its OIDC client, and related data. This
                cannot be undone.
              </p>
              {confirmDelete ? (
                <div className="flex items-center gap-3 p-3 rounded-md bg-red-500/5 border border-red-500/20">
                  <span className="text-sm text-red-300 flex-1">
                    Delete &ldquo;{formData.name.trim() || "this app"}&rdquo;? This cannot be undone.
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      deleteApp().catch(() => undefined);
                    }}
                    disabled={deleting}
                    className="px-3 py-1.5 text-sm font-medium rounded-md bg-red-600 text-white hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {deleting ? "Deleting…" : "Delete"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                    disabled={deleting}
                    className="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="px-4 py-2 text-sm font-medium rounded-md border border-red-500/40 text-red-300 hover:bg-red-500/10 transition-colors"
                >
                  Delete app
                </button>
              )}
            </section>
          )}
        </div>
      )}

      {integrationSection === "credentials" && (
        <div
          id="panel-credentials"
          role="tabpanel"
          aria-labelledby="tab-credentials"
          className="space-y-6 pb-6"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-zinc-100 mb-1">
                Credentials &amp; URLs
              </h2>
              <p className="text-sm text-zinc-500">
                SDK, Builder, and portal credentials — expand each section to configure.
              </p>
            </div>
            <a
              href={API_REFERENCE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 inline-flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-800/50 px-2.5 py-1.5 text-xs font-medium text-zinc-400 hover:border-emerald-500/40 hover:text-emerald-400 transition-colors"
            >
              API Reference
            </a>
          </div>

          {/* Public / SDK — always shown */}
          <CredentialAccordionSection
            id="public"
            label="Public / SDK"
            prefix="app_"
            description="For SDKs, CLIs, and device login. No secret — public only."
            labelClass="text-emerald-200/90"
            prefixClass="text-emerald-400/70"
            expanded={expandedCredentials.has("public")}
            onToggle={() => toggleCredential("public")}
          >
            <CredentialsTestingStep
              activeClient="public"
              {...credentialsTestingStep}
            />
          </CredentialAccordionSection>

          {/* M2M / Builder — only when enabled */}
          {showM2mCredentialsTab && (
            <CredentialAccordionSection
              id="m2m"
              label="M2M / Builder"
              prefix="m2m_"
              description="Server credentials for Builder APIs and device approval."
              labelClass="text-cyan-200/90"
              prefixClass="text-cyan-400/70"
              expanded={expandedCredentials.has("m2m")}
              onToggle={() => toggleCredential("m2m")}
            >
              <CredentialsTestingStep
                activeClient="m2m"
                {...credentialsTestingStep}
              />
            </CredentialAccordionSection>
          )}

          {/* Web SSO — only when enabled */}
          {showWebCredentialsTab && (
            <CredentialAccordionSection
              id="web"
              label="Web SSO"
              prefix="web_"
              description="Confidential client for portal single sign-on."
              labelClass="text-violet-200/90"
              prefixClass="text-violet-400/70"
              expanded={expandedCredentials.has("web")}
              onToggle={() => toggleCredential("web")}
            >
              <CredentialsTestingStep
                activeClient="web"
                {...credentialsTestingStep}
              />
            </CredentialAccordionSection>
          )}

          <ReferenceEndpointsSection
            clientId={appState.clientId || ""}
            discoveryUrl={discoveryUrl}
            authorizeUrl={authorizeUrl}
            tokenUrl={tokenUrl}
            signerSessionUrl={signerSessionUrl}
          />
        </div>
      )}

      {integrationSection === "plans" && (
        <div
          id="panel-plans"
          role="tabpanel"
          aria-labelledby="tab-plans"
        >
          <PlansTab appId={appId} canEdit={canEdit} />
        </div>
      )}

      {integrationSection === "payments" && (
        <div
          id="panel-payments"
          role="tabpanel"
          aria-labelledby="tab-payments"
        >
          <PaymentsTab appId={appId} canManageBilling={canManageBilling} />
        </div>
      )}

      {/* Save - only shown for non-plans/payments tabs */}
      {integrationSection !== "plans" && integrationSection !== "payments" && (
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pt-6 border-t border-zinc-800">
        <p className="text-xs text-zinc-500 max-w-sm">
          Redirects and domains save immediately. Post-logout and profile need{" "}
          <strong className="text-zinc-400">Save changes</strong>.
        </p>
        <div className="flex items-center gap-3 shrink-0">
          {isDirty && !saving && (
            <span className="flex items-center gap-1.5 text-xs text-amber-400">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
              {" "}
              Unsaved changes
            </span>
          )}
          <button
            type="button"
            onClick={() => void saveChanges()}
            disabled={!canEdit || saving || !formData.name.trim()}
            className={`px-5 py-2 text-sm font-medium rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              isDirty
                ? "bg-emerald-600 text-white hover:bg-emerald-500 ring-2 ring-emerald-500/20"
                : "bg-emerald-600 text-white hover:bg-emerald-500"
            }`}
          >
            {saving ? (
              <span className="flex items-center gap-2">
                <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Saving…
              </span>
            ) : "Save changes"}
          </button>
        </div>
      </div>
      )}
    </div>
  );
}

function CredentialsTestingStep({
  activeClient,
  appId,
  appState,
  formData,
  domains,
  onChange,
  onDomainsChange,
  onSecretGenerated,
  onBackendSecretGenerated,
  onWebSecretGenerated,
  ownerExternalUserId,
  readOnly,
  postLogoutRedirectUris,
  onPostLogoutRedirectUrisChange,
  showPostLogoutRedirectUris,
}: Readonly<{
  activeClient: CredentialsClientTab;
  appId: string;
  appState: AppState;
  formData: AppFormData;
  domains: { id: string; domain: string }[];
  onChange: (updates: Partial<AppFormData>) => void;
  onDomainsChange: (domains: { id: string; domain: string }[]) => void;
  onSecretGenerated: () => void;
  onBackendSecretGenerated: () => void;
  onWebSecretGenerated: () => void;
  ownerExternalUserId: string | null;
  readOnly: boolean;
  postLogoutRedirectUris: string[];
  onPostLogoutRedirectUrisChange: (uris: string[]) => void;
  showPostLogoutRedirectUris: boolean;
}>) {
  return (
    <TestingStep
      appId={appId}
      clientId={appState.clientId}
      grantTypes={formData.grantTypes}
      tokenEndpointAuthMethod={formData.tokenEndpointAuthMethod}
      redirectUris={formData.redirectUris}
      allowedScopes={formData.allowedScopes}
      hasSecret={appState.hasSecret}
      backendHelper={appState.backendHelper}
      backendDeviceHelper={formData.backendDeviceHelper}
      webHelper={appState.webHelper}
      confidentialWebHelper={formData.confidentialWebHelper}
      confidentialWebRedirectUris={formData.confidentialWebRedirectUris}
      initiateLoginUri={formData.initiateLoginUri}
      deviceThirdPartyInitiateLogin={formData.deviceThirdPartyInitiateLogin}
      domains={domains}
      onChange={onChange}
      onDomainsChange={onDomainsChange}
      onSecretGenerated={onSecretGenerated}
      onBackendSecretGenerated={onBackendSecretGenerated}
      onWebSecretGenerated={onWebSecretGenerated}
      ownerExternalUserId={ownerExternalUserId}
      readOnly={readOnly}
      activeClient={activeClient}
      hideHeader
      postLogoutRedirectUris={postLogoutRedirectUris}
      onPostLogoutRedirectUrisChange={onPostLogoutRedirectUrisChange}
      showPostLogoutRedirectUris={showPostLogoutRedirectUris}
    />
  );
}

function CredentialAccordionSection({
  id,
  label,
  prefix,
  description,
  labelClass,
  prefixClass,
  expanded,
  onToggle,
  children,
}: Readonly<{
  id: string;
  label: string;
  prefix: string;
  description: string;
  labelClass: string;
  prefixClass: string;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}>) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={`credential-panel-${id}`}
        className="flex w-full items-start justify-between gap-3 px-5 py-4 text-left hover:bg-white/[0.03] transition-colors"
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className={`text-sm font-semibold ${labelClass}`}>{label}</span>
            <code className={`font-mono text-xs ${prefixClass}`}>{prefix}</code>
          </div>
          <p className="text-xs text-zinc-500 mt-0.5">{description}</p>
        </div>
        <svg
          className={`w-4 h-4 shrink-0 mt-0.5 text-zinc-500 transition-transform duration-200 ${
            expanded ? "rotate-180" : ""
          }`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {expanded && (
        <div
          id={`credential-panel-${id}`}
          className="border-t border-white/[0.06] px-5 py-5 sm:px-6 sm:py-6"
        >
          {children}
        </div>
      )}
    </div>
  );
}

function ReferenceEndpointsSection({
  clientId,
  discoveryUrl,
  authorizeUrl,
  tokenUrl,
  signerSessionUrl,
}: Readonly<{
  clientId: string;
  discoveryUrl: string;
  authorizeUrl: string;
  tokenUrl: string;
  signerSessionUrl: string;
}>) {
  const rows = useMemo(
    () =>
      [
        { key: "client", label: "Client ID", value: clientId, accent: true as const },
        { key: "discovery", label: "OIDC discovery", value: discoveryUrl, accent: false as const },
        { key: "authorize", label: "Authorize", value: authorizeUrl, accent: false as const },
        { key: "token", label: "OIDC token", value: tokenUrl, accent: false as const },
        {
          key: "signerSession",
          label: "Signer session exchange",
          value: signerSessionUrl,
          accent: false as const,
        },
      ] as const,
    [authorizeUrl, clientId, discoveryUrl, signerSessionUrl, tokenUrl],
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
    <section className="space-y-3">
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
