"use client";

import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import AppInfoStep from "./steps/AppInfoStep";
import AppModeStep from "./steps/AppModeStep";
import TestingStep from "./steps/TestingStep";
import PlansTab from "./PlansTab";
import {
  defaultAppFormData,
  type AppFormData,
  type AppState,
} from "./AppWizard";

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
  /** Initial tab to display (e.g. "plans" from URL query param). */
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
    initiateLoginUri: initial.initiateLoginUri ?? initialInitiateLoginUri ?? "",
    deviceThirdPartyInitiateLogin:
      initial.deviceThirdPartyInitiateLogin ?? initialDeviceThirdPartyInitiateLogin,
  };
}

const INTEGRATION_TABS = [
  { id: "profile", label: "App profile" },
  { id: "auth", label: "Auth & scopes" },
  { id: "credentials", label: "Credentials & URLs" },
  { id: "plans", label: "Billing Plans" },
] as const;

type IntegrationSection = (typeof INTEGRATION_TABS)[number]["id"];

function resolveInitialTab(tab: string | undefined): IntegrationSection {
  if (tab === "network-discovery") {
    return "plans";
  }
  const validTabs = INTEGRATION_TABS.map((t) => t.id);
  if (tab && validTabs.includes(tab as IntegrationSection)) {
    return tab as IntegrationSection;
  }
  return "profile";
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
  initialTab,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
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
  const [newPostLogoutUri, setNewPostLogoutUri] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [submittingForReview, setSubmittingForReview] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [integrationSection, setIntegrationSection] =
    useState<IntegrationSection>(() => resolveInitialTab(initialTab));
  const tabRefs = useRef<Partial<Record<IntegrationSection, HTMLButtonElement | null>>>({});
  const [savedGrantTypes, setSavedGrantTypes] = useState<string[]>(
    initialData.grantTypes ?? [...defaultAppFormData.grantTypes],
  );

  const selectIntegrationSection = useCallback(
    (section: IntegrationSection, updateUrl = true) => {
      setIntegrationSection(section);

      if (updateUrl) {
        const nextParams = new URLSearchParams(searchParams.toString());
        if (section === "profile") {
          nextParams.delete("tab");
        } else {
          nextParams.set("tab", section);
        }
        const query = nextParams.toString();
        const nextUrl = query ? `${pathname}?${query}` : pathname;
        router.replace(nextUrl, { scroll: false });
      }

      requestAnimationFrame(() => tabRefs.current[section]?.focus());
    },
    [pathname, router, searchParams],
  );

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
      const res = await fetch(`/api/v1/apps/${appId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...formData }),
      });
      const putJson = (await res.json()) as {
        success?: boolean;
        m2mOidcClient?: { clientId: string; hasSecret: boolean } | null;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(putJson.error || `Failed to save (${res.status})`);
      }

      if (putJson.m2mOidcClient) {
        setAppState((s) => ({
          ...s,
          backendHelper: putJson.m2mOidcClient ?? null,
        }));
      }
      setSavedGrantTypes([...formData.grantTypes]);

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
      const res = await fetch(`/api/v1/apps/${appId}/submit`, {
        method: "POST",
      });
      if (!res.ok) {
        const text = await res.text();
        let msg = `Submit failed (${res.status})`;
        try {
          const data = text ? JSON.parse(text) : {};
          if (data.message) msg = data.message;
          else if (data.error) msg = data.error;
        } catch {
          /* keep generic */
        }
        throw new Error(msg);
      }
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
      const res = await fetch(`/api/v1/apps/${appId}/revert-draft`, {
        method: "POST",
      });
      if (!res.ok) {
        const text = await res.text();
        let msg = `Revert failed (${res.status})`;
        try {
          const data = text ? JSON.parse(text) : {};
          if (data.message) msg = data.message;
          else if (data.error) msg = data.error;
        } catch {
          /* keep generic */
        }
        throw new Error(msg);
      }
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
  const showPostLogoutRedirectUris = savedGrantTypes.includes("authorization_code");

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
        {canEdit &&
          canSubmitForReview &&
          (appState.status === "draft" || appState.status === "rejected") && (
            <div className="p-4 rounded-md border border-blue-500/25 bg-blue-500/5 space-y-3">
              <div>
                <h2 className="text-sm font-semibold text-zinc-100">Submit for review</h2>
                <p className="text-sm text-zinc-400 mt-1">
                  While this app is in draft, only you and platform staff can use
                  it. Submit it when you are ready so an administrator can approve
                  it for production.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void submitForReview()}
                disabled={submittingForReview}
                className="px-4 py-2 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {submittingForReview ? "Submitting…" : "Submit for review"}
              </button>
            </div>
          )}
        {canEdit &&
          canSubmitForReview &&
          appState.status === "submitted" && (
            <div className="p-4 rounded-md border border-amber-500/25 bg-amber-500/5 space-y-3">
              <div>
                <h2 className="text-sm font-semibold text-zinc-100">Revert to draft</h2>
                <p className="text-sm text-zinc-400 mt-1">
                  This app is waiting for administrator review. You can withdraw it
                  from the queue to make changes, then submit again.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void revertToDraft()}
                disabled={reverting}
                className="px-4 py-2 text-sm font-medium rounded-md border border-amber-500/40 text-amber-200 hover:bg-amber-500/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {reverting ? "Reverting…" : "Revert to draft"}
              </button>
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

          {canSubmitForReview && appState.status === "draft" && (
            <section className="space-y-3 pt-2 border-t border-zinc-800">
              <h2 className="text-sm font-semibold text-zinc-100">Delete draft app</h2>
              <p className="text-sm text-zinc-400">
                Permanently remove this app, its OIDC client, and related data. This
                cannot be undone.
              </p>
              <button
                type="button"
                onClick={() => void deleteDraftApp()}
                disabled={deleting}
                className="px-4 py-2 text-sm font-medium rounded-md border border-red-500/40 text-red-300 hover:bg-red-500/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {deleting ? "Deleting…" : "Delete app"}
              </button>
            </section>
          )}
        </div>
      )}

      {integrationSection === "auth" && (
        <section
          id="panel-auth"
          role="tabpanel"
          aria-labelledby="tab-auth"
          className="pb-6"
        >
          <AppModeStep
            data={formData}
            onChange={updateFormData}
            readOnly={!canEdit}
          />
        </section>
      )}

      {integrationSection === "credentials" && (
        <div
          id="panel-credentials"
          role="tabpanel"
          aria-labelledby="tab-credentials"
          className="space-y-10 pb-6"
        >
          <section>
            <TestingStep
              appId={appId}
              clientId={appState.clientId}
              grantTypes={formData.grantTypes}
              redirectUris={formData.redirectUris}
              allowedScopes={formData.allowedScopes}
              hasSecret={appState.hasSecret}
              backendHelper={appState.backendHelper}
              backendDeviceHelper={formData.backendDeviceHelper}
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
              readOnly={!canEdit}
            />
          </section>

          {showPostLogoutRedirectUris && (
            <section className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold text-zinc-100">Post-logout Redirects</h2>
                <p className="text-sm text-zinc-500 mt-1">
                  URIs to redirect users to after sign-out for browser-based auth flows. Saved with{" "}
                  <strong className="text-zinc-400">Save changes</strong> below.
                </p>
              </div>
              <div>
                <label
                  htmlFor="postLogoutUriInput"
                  className="block text-sm font-medium text-zinc-300 mb-1.5"
                >
                  Post-logout redirect URIs
                </label>
                <div className="flex gap-2 mb-2">
                  <input
                    id="postLogoutUriInput"
                    type="text"
                    value={newPostLogoutUri}
                    onChange={(e) => setNewPostLogoutUri(e.target.value)}
                    onKeyDown={(e) =>
                      e.key === "Enter" && (e.preventDefault(), addPostLogoutUri())
                    }
                    placeholder="https://example.com/logout-complete"
                    disabled={!canEdit}
                    className="flex-1 px-3 py-1.5 bg-zinc-900 border border-zinc-700 rounded-md text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500/50 disabled:opacity-50 disabled:cursor-not-allowed"
                  />
                  <button
                    type="button"
                    onClick={addPostLogoutUri}
                    disabled={!canEdit}
                    className="px-4 py-1.5 rounded-md bg-zinc-700 text-zinc-200 text-sm hover:bg-zinc-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Add
                  </button>
                </div>
                <div className="space-y-1.5">
                  {postLogoutRedirectUris.map((uri) => (
                    <div
                      key={uri}
                      className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2"
                    >
                      <code className="text-xs text-zinc-300">{uri}</code>
                      <button
                        type="button"
                        onClick={() =>
                          setPostLogoutRedirectUris((items) =>
                            items.filter((item) => item !== uri),
                          )
                        }
                        disabled={!canEdit}
                        className="text-xs text-zinc-500 hover:text-red-400 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          )}

          <ReferenceEndpointsSection
            clientId={appState.clientId || ""}
            discoveryUrl={discoveryUrl}
            authorizeUrl={authorizeUrl}
            tokenUrl={tokenUrl}
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

      {/* Save - only shown for non-plans tabs */}
      {integrationSection !== "plans" && (
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pt-6 border-t border-zinc-800">
        <p className="text-xs text-zinc-500 max-w-sm">
          Redirect URIs and domains update immediately. Use{" "}
          <strong className="text-zinc-400">Save changes</strong> for metadata,
          auth mode, scopes, and OIDC fields.
        </p>
        <button
          type="button"
          onClick={() => void saveChanges()}
          disabled={!canEdit || saving || !formData.name.trim()}
          className="px-5 py-2 text-sm font-medium rounded-md bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
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
