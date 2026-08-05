"use client";

import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
  appSettingsPath,
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
  /** Initial tab to display (from path `/apps/{id}/payments` or legacy `?tab=`). */
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

const INTEGRATION_TABS = [
  { id: "profile", label: "App profile" },
  { id: "credentials", label: "Credentials & URLs" },
  { id: "plans", label: "Billing Plans" },
  { id: "payments", label: "Payments" },
] as const satisfies ReadonlyArray<{ id: AppSettingsTab; label: string }>;

type IntegrationSection = AppSettingsTab;

function resolveInitialTab(tab: string | undefined): IntegrationSection {
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
  const searchParams = useSearchParams();
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
  const [credentialsClient, setCredentialsClient] =
    useState<CredentialsClientTab>("public");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const messageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [integrationSection, setIntegrationSection] =
    useState<IntegrationSection>(() => resolveInitialTab(initialTab));
  const tabRefs = useRef<Partial<Record<IntegrationSection, HTMLButtonElement | null>>>({});

  const selectIntegrationSection = useCallback(
    (section: IntegrationSection, updateUrl = true) => {
      setIntegrationSection(section);

      if (updateUrl) {
        const nextParams = new URLSearchParams(searchParams.toString());
        nextParams.delete("tab");
        if (section !== "credentials") {
          nextParams.delete("client");
        }
        const query = nextParams.toString();
        const path = appSettingsPath(appId, section);
        const nextUrl = query ? `${path}?${query}` : path;
        router.replace(nextUrl, { scroll: false });
      }

      requestAnimationFrame(() => tabRefs.current[section]?.focus());
    },
    [appId, router, searchParams],
  );

  const credentialsTabRefs = useRef<
    Partial<Record<CredentialsClientTab, HTMLButtonElement | null>>
  >({});

  const selectCredentialsClient = useCallback(
    (client: CredentialsClientTab, updateUrl = true) => {
      setCredentialsClient(client);
      if (updateUrl) {
        const nextParams = new URLSearchParams(searchParams.toString());
        nextParams.delete("tab");
        if (client === "public") {
          nextParams.delete("client");
        } else {
          nextParams.set("client", client);
        }
        const query = nextParams.toString();
        const path = appSettingsPath(appId, "credentials");
        router.replace(query ? `${path}?${query}` : path, { scroll: false });
      }
      requestAnimationFrame(() => credentialsTabRefs.current[client]?.focus());
    },
    [appId, router, searchParams],
  );

  useEffect(() => {
    const clientParam = searchParams.get("client");
    if (clientParam === "m2m" || clientParam === "web" || clientParam === "public") {
      setCredentialsClient(clientParam);
    }
  }, [searchParams]);

  useEffect(() => {
    const resolvedTab = resolveInitialTab(initialTab);
    setIntegrationSection((currentTab) =>
      currentTab === resolvedTab ? currentTab : resolvedTab,
    );
  }, [initialTab]);

  const handleIntegrationTabKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, id: IntegrationSection) => {
      const currentIndex = INTEGRATION_TABS.findIndex((tab) => tab.id === id);
      if (currentIndex === -1) return;

      let nextIndex: number | null = null;
      if (event.key === "ArrowLeft") {
        nextIndex =
          (currentIndex - 1 + INTEGRATION_TABS.length) % INTEGRATION_TABS.length;
      } else if (event.key === "ArrowRight") {
        nextIndex = (currentIndex + 1) % INTEGRATION_TABS.length;
      } else if (event.key === "Home") {
        nextIndex = 0;
      } else if (event.key === "End") {
        nextIndex = INTEGRATION_TABS.length - 1;
      }

      if (nextIndex === null) return;
      event.preventDefault();
      selectIntegrationSection(INTEGRATION_TABS[nextIndex].id);
    },
    [selectIntegrationSection],
  );

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

  const credentialsClientTabs = useMemo(
    () =>
      (
        [
          {
            id: "public" as const,
            label: "Public / SDK",
            hint: "app_",
            show: true,
          },
          {
            id: "m2m" as const,
            label: "M2M / Builder",
            hint: "m2m_",
            show: showM2mCredentialsTab,
          },
          {
            id: "web" as const,
            label: "Web SSO",
            hint: "web_",
            show: showWebCredentialsTab,
          },
        ] as const
      ).filter((tab) => tab.show),
    [showM2mCredentialsTab, showWebCredentialsTab],
  );

  const handleCredentialsClientTabKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, id: CredentialsClientTab) => {
      const currentIndex = credentialsClientTabs.findIndex((tab) => tab.id === id);
      if (currentIndex === -1) return;

      let nextIndex: number | null = null;
      if (event.key === "ArrowLeft") {
        nextIndex =
          (currentIndex - 1 + credentialsClientTabs.length) %
          credentialsClientTabs.length;
      } else if (event.key === "ArrowRight") {
        nextIndex = (currentIndex + 1) % credentialsClientTabs.length;
      } else if (event.key === "Home") {
        nextIndex = 0;
      } else if (event.key === "End") {
        nextIndex = credentialsClientTabs.length - 1;
      }

      if (nextIndex === null) return;
      event.preventDefault();
      selectCredentialsClient(credentialsClientTabs[nextIndex].id);
    },
    [credentialsClientTabs, selectCredentialsClient],
  );

  useEffect(() => {
    if (
      (credentialsClient === "m2m" && !showM2mCredentialsTab) ||
      (credentialsClient === "web" && !showWebCredentialsTab)
    ) {
      selectCredentialsClient("public");
    }
  }, [
    credentialsClient,
    selectCredentialsClient,
    showM2mCredentialsTab,
    showWebCredentialsTab,
  ]);

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

      <nav
        className="flex flex-wrap gap-1 border-b border-zinc-800 pb-3 mb-6"
        role="tablist"
        aria-label="Integration settings sections"
      >
        {INTEGRATION_TABS.map(({ id, label }) => {
          const selected = integrationSection === id;
          return (
            <button
              key={id}
              id={`tab-${id}`}
              ref={(node) => {
                tabRefs.current[id] = node;
              }}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`panel-${id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => selectIntegrationSection(id)}
              onKeyDown={(event) => handleIntegrationTabKeyDown(event, id)}
              className={`px-3 py-2 text-sm font-medium rounded-t-md border-b-2 -mb-px transition-colors ${
                selected
                  ? "border-emerald-500 text-emerald-400 bg-zinc-900/50"
                  : "border-transparent text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {label}
            </button>
          );
        })}
      </nav>

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
          className="space-y-8 pb-6"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-zinc-100 mb-1">
                Credentials &amp; URLs
              </h2>
              <p className="text-sm text-zinc-500">
                SDK, Builder, and portal credentials — each on its own tab.
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

          <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 overflow-hidden">
            <div
              className="flex flex-wrap gap-0 border-b border-zinc-800 bg-zinc-900/50"
              role="tablist"
              aria-label="OIDC client credentials"
            >
              {credentialsClientTabs.map((tab) => {
                  const selected = credentialsClient === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      id={`credentials-client-tab-${tab.id}`}
                      ref={(node) => {
                        credentialsTabRefs.current[tab.id] = node;
                      }}
                      aria-selected={selected}
                      aria-controls={`credentials-client-panel-${tab.id}`}
                      tabIndex={selected ? 0 : -1}
                      onClick={() => selectCredentialsClient(tab.id)}
                      onKeyDown={(event) =>
                        handleCredentialsClientTabKeyDown(event, tab.id)
                      }
                      className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                        selected
                          ? "border-emerald-500 text-zinc-100 bg-zinc-900/80"
                          : "border-transparent text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/40"
                      }`}
                    >
                      {tab.label}{" "}
                      <code
                        className={`font-mono text-xs ${
                          selected ? "text-zinc-400" : "text-zinc-600"
                        }`}
                      >
                        {tab.hint}
                      </code>
                    </button>
                  );
                })}
            </div>

            <div
              id={`credentials-client-panel-${credentialsClient}`}
              role="tabpanel"
              aria-labelledby={`credentials-client-tab-${credentialsClient}`}
              className="p-5 sm:p-6 space-y-8"
            >
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
                onChange={updateFormData}
                onDomainsChange={setDomains}
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
                onWebSecretGenerated={() => {
                  setAppState((s) => ({
                    ...s,
                    webHelper: s.webHelper
                      ? { ...s.webHelper, hasSecret: true }
                      : s.webHelper,
                  }));
                }}
                ownerExternalUserId={ownerExternalUserId}
                readOnly={!canEdit}
                activeClient={credentialsClient}
                hideHeader
                postLogoutRedirectUris={postLogoutRedirectUris}
                onPostLogoutRedirectUrisChange={(uris) =>
                  updatePostLogoutRedirectUris(uris)
                }
                showPostLogoutRedirectUris={showPostLogoutRedirectUris}
              />
            </div>
          </div>

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
