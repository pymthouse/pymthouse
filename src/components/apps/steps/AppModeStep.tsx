"use client";

import { useCallback, useEffect } from "react";
import type { AppFormData } from "@/domains/developer-apps/ui/app-editor";
import {
  buildAppAuthModeModel,
  ensureRequiredUserTokenScope,
  getInitiateLoginUpdates,
  getToggledScopeUpdates,
  getToggleDeviceCodeUpdates,
  getToggleHelperUpdates,
  getToggleRefreshTokenUpdates,
} from "@/domains/developer-apps/ui/app-auth-mode";
import { OIDC_SCOPES } from "@/platform/oidc/scopes";
import AuthorizationCodeRedirectBlock from "./AuthorizationCodeRedirectBlock";

const noopDomainsChange = (_domains: { id: string; domain: string }[]) => {};

interface Props {
  data: AppFormData;
  onChange: (updates: Partial<AppFormData>) => void;
  readOnly?: boolean;
  /** Present on the app settings page so redirect URIs persist immediately. */
  appId?: string | null;
  domains?: { id: string; domain: string }[];
  onDomainsChange?: (domains: { id: string; domain: string }[]) => void;
}

export default function AppModeStep({
  data,
  onChange,
  readOnly = false,
  appId = null,
  domains = [],
  onDomainsChange,
}: Props) {
  const stableOnDomainsChange = useCallback(
    (nextDomains: { id: string; domain: string }[]) => {
      (onDomainsChange ?? noopDomainsChange)(nextDomains);
    },
    [onDomainsChange],
  );
  const {
    scopes,
    hasDeviceCode,
    hasAuthCodeFlow,
    requiresIssueUserTokens,
    hasIssueUserTokens,
    baseScopes,
    helperScopes,
  } = buildAppAuthModeModel(data);

  const toggleScope = (scope: string) => {
    const updates = getToggledScopeUpdates(data, scope, readOnly);
    if (!updates) return;
    onChange(updates);
  };

  useEffect(() => {
    const updates = ensureRequiredUserTokenScope(data);
    if (!updates) return;
    onChange(updates);
  }, [data, onChange]);

  const toggleRefreshToken = () => {
    const updates = getToggleRefreshTokenUpdates(data, readOnly);
    if (!updates) return;
    onChange(updates);
  };

  const toggleDeviceCode = () => {
    const updates = getToggleDeviceCodeUpdates(data, readOnly);
    if (!updates) return;
    onChange(updates);
  };

  const toggleHelper = (checked: boolean) => {
    const updates = getToggleHelperUpdates(data, checked, readOnly);
    if (!updates) return;
    onChange(updates);
  };

  const scopeRow = (
    scope: (typeof OIDC_SCOPES)[number],
    accentClass = "emerald",
  ) => (
    <label
      key={scope.value}
      className={`flex items-center gap-3 p-3 rounded-lg border transition-colors ${
        scopes.includes(scope.value)
          ? `border-${accentClass}-500/30 bg-${accentClass}-500/5`
          : "border-zinc-800 bg-zinc-800/20"
      } ${scope.required || readOnly || (scope.value === "users:token" && requiresIssueUserTokens) ? "opacity-70" : "cursor-pointer hover:border-zinc-600"}`}
    >
      <input
        type="checkbox"
        checked={scopes.includes(scope.value)}
        onChange={() => toggleScope(scope.value)}
        disabled={
          scope.required ||
          readOnly ||
          (scope.value === "users:token" && requiresIssueUserTokens)
        }
        className={`w-4 h-4 rounded border-zinc-600 bg-zinc-800 text-${accentClass}-500 focus:ring-${accentClass}-500/40 shrink-0`}
      />
      <div>
        <p className="text-sm font-medium text-zinc-200">
          {scope.label}
          {(scope.required || (scope.value === "users:token" && requiresIssueUserTokens)) && (
            <span className="ml-1.5 text-[10px] font-normal text-zinc-500 uppercase tracking-wide">
              (required)
            </span>
          )}
        </p>
        <p className="text-xs text-zinc-500">{scope.description}</p>
      </div>
    </label>
  );

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-zinc-100 mb-1">Auth & Scopes</h2>
        <p className="text-sm text-zinc-500">
          Configure grants and scopes for this provider app.
        </p>
      </div>

      <div className="space-y-6 border-t border-zinc-800 pt-6">

        {/* ── Confidential client (top-level parent) ── */}
        <div className="rounded-xl border border-zinc-700/80 bg-zinc-800/20 p-4 space-y-3">
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={Boolean(data.backendDeviceHelper)}
              onChange={(e) => toggleHelper(e.target.checked)}
              disabled={readOnly}
              className="w-4 h-4 mt-0.5 rounded border-zinc-600 bg-zinc-800 text-emerald-500 focus:ring-emerald-500/40 shrink-0 disabled:opacity-50"
            />
            <div>
              <p className="text-sm font-medium text-zinc-200">
                Confidential client{" "}
                <span className="text-[10px] font-normal text-zinc-500 uppercase tracking-wide">
                  (client credentials)
                </span>
              </p>
              <p className="text-xs text-zinc-500 mt-1">
                Provisions a confidential{" "}
                <code className="font-mono text-zinc-400">m2m_</code> client that
                authenticates with client credentials for server-to-server Builder
                APIs and inherits{" "}
                <code className="font-mono text-zinc-400">sign:job</code> /{" "}
                <code className="font-mono text-zinc-400">users:read</code> when those
                scopes are enabled on your public client. Your public client stays
                unauthenticated for SDK / CLI device login.
              </p>
            </div>
          </label>

          {data.backendDeviceHelper && (
            <>
              {/* Companion scopes info chip */}
              <div className="rounded-lg border border-zinc-700/70 bg-zinc-800/30 px-3 py-2 text-xs text-zinc-400">
                Companion client always includes{" "}
                <code className="font-mono text-zinc-300">
                  users:token users:write device:approve
                </code>
                , plus <code className="font-mono text-zinc-300">sign:job</code> and/or{" "}
                <code className="font-mono text-zinc-300">users:read</code> when your
                public app has those scopes.
              </div>

              {/* ── Device Authorization Flow (child of helper) ── */}
              <div className="border-t border-zinc-700/60 pt-3 space-y-3">
                <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
                  Device login
                </p>
                <label
                  className={`flex items-start gap-3 p-3 rounded-lg border transition-colors cursor-pointer ${
                    hasDeviceCode
                      ? "border-emerald-500/30 bg-emerald-500/5"
                      : "border-zinc-700 bg-zinc-800/20 hover:border-zinc-600"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={hasDeviceCode}
                    onChange={toggleDeviceCode}
                    disabled={readOnly}
                    className="w-4 h-4 mt-0.5 rounded border-zinc-600 bg-zinc-800 text-emerald-500 focus:ring-emerald-500/40 shrink-0 disabled:opacity-50"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-zinc-200">
                      Device Authorization Flow{" "}
                      <span className="text-[10px] font-normal text-zinc-500 uppercase tracking-wide">
                        (RFC 8628)
                      </span>
                    </p>
                    <p className="text-xs text-zinc-500 mt-0.5">
                      Allow CLI tools, SDKs, and headless clients to authenticate
                      via a user code on a secondary device.
                    </p>

                    {/* ── Third-party initiate login (grandchild — only when device_code is on) ── */}
                    {hasDeviceCode && (
                      <div className="mt-3 border-t border-zinc-700/50 pt-3 space-y-3">
                        <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
                          Third-party initiate login
                        </p>
                        <div>
                          <label className="block text-xs font-medium text-zinc-400 mb-1">
                            Initiate login URI
                          </label>
                          <input
                            type="url"
                            value={data.initiateLoginUri}
                            onChange={(e) => onChange(getInitiateLoginUpdates(e.target.value))}
                            placeholder="https://example.com/api/auth/initiate-login"
                            disabled={readOnly}
                            className="w-full px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-sm text-zinc-100 placeholder:text-zinc-600 disabled:opacity-50 disabled:cursor-not-allowed"
                          />
                          <p className="text-xs text-zinc-500 mt-1">
                            OIDC{" "}
                            <code className="font-mono text-zinc-400">
                              initiate_login_uri
                            </code>{" "}
                            — when set, unauthenticated device verification
                            redirects here with{" "}
                            <code className="font-mono text-zinc-400">iss</code>{" "}
                            and{" "}
                            <code className="font-mono text-zinc-400">
                              target_link_uri
                            </code>
                            . Your app must return users to{" "}
                            <code className="font-mono text-zinc-400">
                              target_link_uri
                            </code>{" "}
                            after login.
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                </label>
              </div>
            </>
          )}
        </div>

        {/* ── Grant Types (auth_code always required; refresh_token optional) ── */}
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-zinc-300">Grant Types</label>
            <p className="text-xs text-zinc-500 mt-0.5">
              Authorization Code + PKCE is always enabled for interactive apps.
            </p>
          </div>
          <div className="space-y-2">
            <div className="rounded-lg border border-zinc-800 bg-zinc-800/20 overflow-hidden">
              <label className="flex items-center gap-3 p-3 opacity-70 cursor-not-allowed">
                <input
                  type="checkbox"
                  checked
                  readOnly
                  disabled
                  className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 text-emerald-500 shrink-0"
                />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-zinc-200">
                    Authorization Code + PKCE
                    <span className="ml-1.5 text-[10px] font-normal text-zinc-500 uppercase tracking-wide">
                      (required)
                    </span>
                  </p>
                  <p className="text-xs text-zinc-500">
                    Browser redirect flow — the foundation of interactive sign-in. Always required for
                    this app type.
                  </p>
                </div>
              </label>
              {hasAuthCodeFlow && (
                <div className="border-t border-zinc-700/60 bg-zinc-900/25 px-3 py-4 space-y-1">
                  <p className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider mb-3">
                    Redirect &amp; browser security
                  </p>
                  <AuthorizationCodeRedirectBlock
                    appId={appId}
                    redirectUris={data.redirectUris}
                    onRedirectUrisChange={(uris) => onChange({ redirectUris: uris })}
                    domains={domains}
                    onDomainsChange={stableOnDomainsChange}
                    readOnly={readOnly}
                  />
                </div>
              )}
            </div>
            <label
              className={`flex items-start gap-3 p-3 rounded-lg border transition-colors cursor-pointer ${
                data.grantTypes.includes("refresh_token")
                  ? "border-emerald-500/30 bg-emerald-500/5"
                  : "border-zinc-800 bg-zinc-800/20 hover:border-zinc-600"
              }`}
            >
              <input
                type="checkbox"
                checked={data.grantTypes.includes("refresh_token")}
                onChange={toggleRefreshToken}
                disabled={readOnly}
                className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 text-emerald-500 focus:ring-emerald-500/40 mt-0.5 shrink-0 disabled:opacity-50"
              />
              <div>
                <p className="text-sm font-medium text-zinc-200">Refresh Token</p>
                <p className="text-xs text-zinc-500 mt-0.5">
                  Allow direct refresh at the token endpoint after the initial
                  interactive sign-in.
                </p>
              </div>
            </label>
          </div>
        </div>

        {/* ── Scopes ── */}
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-zinc-300">Scopes</label>
            <p className="text-xs text-zinc-500 mt-0.5">
              Keep interactive scopes narrow for the MVP runtime path.
            </p>
          </div>
          <div className="space-y-2">
            {baseScopes.map((s) => scopeRow(s))}
            {data.backendDeviceHelper && helperScopes.map((s) => scopeRow(s))}
          </div>
        </div>
      </div>
    </div>
  );
}
