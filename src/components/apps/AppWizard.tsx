"use client";

import { useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { docsDeviceFlowUrl } from "@/lib/docs-base-url";
import {
  DEFAULT_PUBLIC_GRANT_TYPES,
  DEVICE_CODE_GRANT,
} from "@/lib/oidc/grants";
import { DEFAULT_OIDC_SCOPES, ensureOpenIdScope, OIDC_SCOPES } from "@/lib/oidc/scopes";

const DEVICE_FLOW_GRANT = DEVICE_CODE_GRANT;

const USERS_TOKEN_SCOPE = OIDC_SCOPES.find((s) => s.value === "users:token")!;

export interface AppFormData {
  name: string;
  description: string;
  developerName: string;
  websiteUrl: string;
  tokenEndpointAuthMethod: "none" | "client_secret_post" | "client_secret_basic";
  redirectUris: string[];
  allowedScopes: string;
  grantTypes: string[];
  /** Provisions the confidential M2M sibling (Builder API + device approval via token exchange); keeps the public client unauthenticated. */
  backendDeviceHelper: boolean;
  /** OIDC initiate_login_uri for third-party device login. */
  initiateLoginUri: string;
  /** Whether to redirect unauthenticated device verification to initiateLoginUri. */
  deviceThirdPartyInitiateLogin: boolean;
}

export interface AppState {
  id: string | null;
  clientId: string | null;
  status: string;
  hasSecret: boolean;
  /** Confidential backend helper client (null until provisioned). */
  backendHelper: { clientId: string; hasSecret: boolean } | null;
  pendingRevisionSubmittedAt?: string | null;
}

const DEFAULT_GRANT_TYPES_WITH_DEVICE = [
  ...DEFAULT_PUBLIC_GRANT_TYPES,
  DEVICE_FLOW_GRANT,
] as const;

export const defaultAppFormData: AppFormData = {
  name: "",
  description: "",
  developerName: "",
  websiteUrl: "",
  tokenEndpointAuthMethod: "none",
  redirectUris: [],
  allowedScopes: `${DEFAULT_OIDC_SCOPES} users:token`.trim(),
  grantTypes: [...DEFAULT_GRANT_TYPES_WITH_DEVICE],
  backendDeviceHelper: true,
  initiateLoginUri: "",
  deviceThirdPartyInitiateLogin: false,
};

interface Props {
  initialData?: Partial<AppFormData>;
  initialState?: AppState;
  initialDomains?: { id: string; domain: string }[];
}

const fieldClass =
  "w-full px-3 py-1.5 bg-zinc-900 border border-zinc-700 rounded-md text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500/50 disabled:opacity-50";

function parseScopes(allowedScopes: string): string[] {
  return allowedScopes.split(/\s+/).filter(Boolean);
}

function joinScopes(scopes: string[]): string {
  return scopes.join(" ");
}

export default function AppWizard({ initialData }: Props) {
  const router = useRouter();
  const [formData, setFormData] = useState<AppFormData>({
    ...defaultAppFormData,
    ...initialData,
    grantTypes:
      initialData?.grantTypes !== undefined
        ? [...initialData.grantTypes]
        : [...defaultAppFormData.grantTypes],
    redirectUris:
      initialData?.redirectUris !== undefined
        ? [...initialData.redirectUris]
        : [...defaultAppFormData.redirectUris],
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasDeviceCode = formData.grantTypes.includes(DEVICE_FLOW_GRANT);
  const scopesList = useMemo(() => parseScopes(formData.allowedScopes), [formData.allowedScopes]);
  const hasIssueUserTokens = scopesList.includes("users:token");

  const set = useCallback(<K extends keyof AppFormData>(key: K, value: AppFormData[K]) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
  }, []);

  const toggleConfidential = (checked: boolean) => {
    if (!checked) {
      setFormData((prev) => {
        const scopes = parseScopes(prev.allowedScopes).filter((s) => s !== "users:token");
        return {
          ...prev,
          backendDeviceHelper: false,
          grantTypes: prev.grantTypes.filter((g) => g !== DEVICE_FLOW_GRANT),
          allowedScopes: ensureOpenIdScope(joinScopes(scopes)),
          initiateLoginUri: "",
          deviceThirdPartyInitiateLogin: false,
        };
      });
      return;
    }
    setFormData((prev) => {
      const scopes = parseScopes(prev.allowedScopes);
      const nextScopes = scopes.includes("users:token") ? scopes : [...scopes, "users:token"];
      return {
        ...prev,
        backendDeviceHelper: true,
        allowedScopes: ensureOpenIdScope(joinScopes(nextScopes)),
      };
    });
  };

  const toggleDeviceCode = () => {
    if (!formData.backendDeviceHelper) return;
    if (hasDeviceCode) {
      set("grantTypes", formData.grantTypes.filter((v) => v !== DEVICE_FLOW_GRANT));
      return;
    }
    setFormData((prev) => ({
      ...prev,
      grantTypes: prev.grantTypes.includes(DEVICE_FLOW_GRANT)
        ? prev.grantTypes
        : [...prev.grantTypes, DEVICE_FLOW_GRANT],
    }));
  };

  const toggleIssueUserTokens = () => {
    if (!formData.backendDeviceHelper) return;
    const scopes = parseScopes(formData.allowedScopes);
    const next = hasIssueUserTokens
      ? scopes.filter((s) => s !== "users:token")
      : [...scopes, "users:token"];
    set("allowedScopes", ensureOpenIdScope(joinScopes(next)));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      // Let the server enforce the authorization_code ↔ redirect_uris coupling.
      // We submit the grant list as-is; syncPublicClientGrantTypes on the server
      // will add/remove authorization_code based on whether redirectUris is non-empty.
      const payload: AppFormData = {
        ...formData,
        allowedScopes: ensureOpenIdScope(formData.allowedScopes),
      };
      const res = await fetch("/api/v1/apps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const text = await res.text();
        let msg = `Failed to create app (${res.status})`;
        try {
          const data = text ? JSON.parse(text) : {};
          if (data && typeof data === "object") {
            if (typeof (data as { message?: unknown }).message === "string") {
              msg = (data as { message: string }).message;
            } else if (typeof (data as { error?: unknown }).error === "string") {
              msg = (data as { error: string }).error;
            }
          }
        } catch {
          if (text?.trim()) msg = text.trim().slice(0, 500);
        }
        throw new Error(msg);
      }
      const data = await res.json();
      router.push(`/apps/${data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  };

  const canSubmit = !saving && formData.name.trim().length > 0;

  return (
    <div className="max-w-[540px]">
      <h1 className="text-lg font-semibold text-zinc-100 pb-4 mb-6 border-b border-zinc-800">
        Register a new OAuth app
      </h1>

      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-5">
        {error && (
          <div className="p-3 rounded-md bg-red-500/10 border border-red-500/20 text-red-300 text-sm">
            {error}
          </div>
        )}

        {/* Application name */}
        <div>
          <label htmlFor="wizard-app-name" className="block text-sm font-medium text-zinc-200 mb-1.5">
            Application name <span className="text-red-400">*</span>
          </label>
          <input
            id="wizard-app-name"
            type="text"
            value={formData.name}
            onChange={(e) => set("name", e.target.value)}
            autoFocus
            required
            className={fieldClass}
          />
          <p className="text-xs text-zinc-500 mt-1.5">Something users will recognize and trust.</p>
        </div>

        {/* Developer / organization name */}
        <div>
          <label htmlFor="wizard-developer-name" className="block text-sm font-medium text-zinc-200 mb-1.5">
            Developer / organization name
          </label>
          <input
            id="wizard-developer-name"
            type="text"
            value={formData.developerName}
            onChange={(e) => set("developerName", e.target.value)}
            placeholder="Acme Inc."
            className={fieldClass}
          />
        </div>

        {/* Homepage URL (optional) */}
        <div>
          <label htmlFor="wizard-homepage-url" className="block text-sm font-medium text-zinc-200 mb-1.5">
            Homepage URL <span className="text-zinc-500 font-normal">(optional)</span>
          </label>
          <input
            id="wizard-homepage-url"
            type="url"
            value={formData.websiteUrl}
            onChange={(e) => set("websiteUrl", e.target.value)}
            placeholder="https://"
            className={fieldClass}
          />
          <p className="text-xs text-zinc-500 mt-1.5">
            Shown on consent and in marketplace listings when set.
          </p>
        </div>

        {/* Description */}
        <div>
          <label htmlFor="wizard-description" className="block text-sm font-medium text-zinc-200 mb-1.5">
            Application description
          </label>
          <textarea
            id="wizard-description"
            value={formData.description}
            onChange={(e) => set("description", e.target.value)}
            rows={3}
            placeholder="Application description is optional"
            className={`${fieldClass} resize-none`}
          />
          <p className="text-xs text-zinc-500 mt-1.5">
            This is displayed to all users of your application.
          </p>
        </div>

        {/* OAuth capabilities */}
        <div className="rounded-xl border border-zinc-700/80 bg-zinc-800/20 p-4 space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">OAuth capabilities</h2>
            <p className="text-xs text-zinc-500 mt-0.5">
              Device flow depends on a confidential (M2M) companion client in this product.
            </p>
          </div>

          <label
            aria-label="Confidential client"
            className="flex items-start gap-3 cursor-pointer"
          >
            <input
              type="checkbox"
              checked={Boolean(formData.backendDeviceHelper)}
              onChange={(e) => toggleConfidential(e.target.checked)}
              className="w-4 h-4 mt-0.5 rounded border-zinc-600 bg-zinc-800 text-emerald-500 focus:ring-emerald-500/40 shrink-0"
            />
            <span>
              <span className="block text-sm font-medium text-zinc-200">
                Confidential client{" "}
                <span className="text-[10px] font-normal text-zinc-500 uppercase tracking-wide">
                  (client credentials)
                </span>
              </span>
              <span className="block text-xs text-zinc-500 mt-1">
                Provisions a confidential{" "}
                <code className="font-mono text-zinc-400">m2m_</code> client for
                server-to-server Builder APIs. Your public client stays unauthenticated for SDK
                / CLI device login.
              </span>
            </span>
          </label>

          <div>
            <label
              aria-label="Enable Device Flow"
              className={`flex items-start gap-3 ${
                formData.backendDeviceHelper ? "cursor-pointer" : "cursor-not-allowed opacity-60"
              }`}
            >
              <input
                type="checkbox"
                checked={hasDeviceCode}
                onChange={toggleDeviceCode}
                disabled={!formData.backendDeviceHelper}
                className="w-4 h-4 mt-0.5 rounded border-zinc-600 bg-zinc-800 text-emerald-500 focus:ring-emerald-500/40 shrink-0 disabled:opacity-50"
              />
              <span>
                <span className="block text-sm font-medium text-zinc-200">Enable Device Flow</span>
                <span className="block text-xs text-zinc-500 mt-0.5">
                  Allow CLI tools, SDKs, and headless clients to authorize via a user code.{" "}
                  <a
                    href={docsDeviceFlowUrl()}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-emerald-500 hover:underline"
                  >
                    Device Flow documentation
                  </a>
                </span>
              </span>
            </label>
            {!formData.backendDeviceHelper && (
              <p className="text-xs text-zinc-600 mt-1.5 ml-[26px]">
                Turn on Confidential client first.
              </p>
            )}
          </div>

          {formData.backendDeviceHelper && (
            <label
              aria-label={USERS_TOKEN_SCOPE.label}
              className="flex items-start gap-3 cursor-pointer rounded-lg border border-zinc-700/70 bg-zinc-800/30 p-3"
            >
              <input
                type="checkbox"
                checked={hasIssueUserTokens}
                onChange={toggleIssueUserTokens}
                className="w-4 h-4 mt-0.5 rounded border-zinc-600 bg-zinc-800 text-emerald-500 focus:ring-emerald-500/40 shrink-0"
              />
              <span>
                <span className="block text-sm font-medium text-zinc-200">{USERS_TOKEN_SCOPE.label}</span>
                <span className="block text-xs text-zinc-500 mt-0.5">{USERS_TOKEN_SCOPE.description}</span>
              </span>
            </label>
          )}

          <div className="rounded-lg border border-zinc-700/50 bg-zinc-900/40 px-3 py-2.5 text-xs text-zinc-400 leading-relaxed">
            <strong className="text-zinc-300">Custom login for device approval:</strong> after you
            register, open{" "}
            <strong className="text-zinc-400">App settings → Auth &amp; scopes → Device login</strong>{" "}
            and set <strong className="text-zinc-400">Initiate login URI</strong> so users complete
            sign-in on your site instead of the default PymtHouse device page.
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-4 pt-2">
          <button
            type="submit"
            disabled={!canSubmit}
            className="px-4 py-2 text-sm font-medium rounded-md bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? "Registering…" : "Register application"}
          </button>
          <button
            type="button"
            onClick={() => router.push("/apps")}
            className="text-sm text-emerald-500 hover:underline"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
