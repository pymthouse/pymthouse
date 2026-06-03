"use client";

import { useEffect } from "react";
import type { AppFormData } from "../AppWizard";
import {
  AUTHORIZATION_CODE_GRANT,
  DEVICE_CODE_GRANT,
  ensureAuthorizationCodeGrant,
} from "@/lib/oidc/grants";
import { ensureOpenIdScope, OIDC_SCOPES } from "@/lib/oidc/scopes";
import { validateInitiateLoginUri } from "@/lib/oidc/third-party-initiate-login";

function isValidInitiateLoginUri(uri: string): boolean {
  const t = uri.trim();
  if (!t.length) return false;
  try {
    validateInitiateLoginUri(t);
    return true;
  } catch {
    return false;
  }
}

interface Props {
  data: AppFormData;
  onChange: (updates: Partial<AppFormData>) => void;
  readOnly?: boolean;
}

export default function AppModeStep({
  data,
  onChange,
  readOnly = false,
}: Props) {
  const scopes = data.allowedScopes.split(/\s+/).filter(Boolean);
  const hasDeviceCode = data.grantTypes.includes(DEVICE_CODE_GRANT);
  const requiresIssueUserTokens =
    hasDeviceCode && data.deviceThirdPartyInitiateLogin && isValidInitiateLoginUri(data.initiateLoginUri);
  const hasIssueUserTokens = scopes.includes("users:token");

  // sign:job always visible; openid is implicit; users:token only when helper is on
  const baseScopes = OIDC_SCOPES.filter(
    (s) => s.value === "sign:job" && !s.hiddenInAppConfig,
  );
  const helperScopes = OIDC_SCOPES.filter((s) => s.value === "users:token");

  const setAllowedScopes = (next: string) => {
    onChange({ allowedScopes: ensureOpenIdScope(next) });
  };

  useEffect(() => {
    if (scopes.includes("openid")) return;
    setAllowedScopes(data.allowedScopes);
  }, [data.allowedScopes, scopes, onChange]);

  useEffect(() => {
    if (data.grantTypes.includes(AUTHORIZATION_CODE_GRANT)) return;
    onChange({ grantTypes: ensureAuthorizationCodeGrant(data.grantTypes) });
  }, [data.grantTypes, onChange]);

  const setGrantTypes = (next: string[]) => {
    onChange({ grantTypes: ensureAuthorizationCodeGrant(next) });
  };

  const toggleScope = (scope: string) => {
    if (readOnly) return;
    if (scope === "users:token" && requiresIssueUserTokens) return;
    const next = scopes.includes(scope)
      ? scopes.filter((v) => v !== scope)
      : [...scopes, scope];
    setAllowedScopes(next.join(" "));
  };

  useEffect(() => {
    if (!requiresIssueUserTokens || hasIssueUserTokens) return;
    setAllowedScopes([...scopes, "users:token"].join(" "));
  }, [hasIssueUserTokens, requiresIssueUserTokens, scopes]);

  const toggleRefreshToken = () => {
    if (readOnly) return;
    const has = data.grantTypes.includes("refresh_token");
    setGrantTypes(
      has
        ? data.grantTypes.filter((v) => v !== "refresh_token")
        : [...data.grantTypes, "refresh_token"],
    );
  };

  const toggleDeviceCode = () => {
    if (readOnly || !data.backendDeviceHelper) return;
    if (hasDeviceCode) {
      onChange({
        grantTypes: ensureAuthorizationCodeGrant(
          data.grantTypes.filter((v) => v !== DEVICE_CODE_GRANT),
        ),
        initiateLoginUri: "",
        deviceThirdPartyInitiateLogin: false,
      });
    } else {
      setGrantTypes([...data.grantTypes, DEVICE_CODE_GRANT]);
    }
  };

  const toggleHelper = (checked: boolean) => {
    if (readOnly) return;
    if (checked) {
      const nextScopes = scopes.includes("users:token") ? scopes : [...scopes, "users:token"];
      onChange({
        backendDeviceHelper: true,
        allowedScopes: ensureOpenIdScope(nextScopes.join(" ")),
      });
    } else {
      onChange({
        backendDeviceHelper: false,
        grantTypes: ensureAuthorizationCodeGrant(
          data.grantTypes.filter((v) => v !== DEVICE_CODE_GRANT),
        ),
        initiateLoginUri: "",
        deviceThirdPartyInitiateLogin: false,
        allowedScopes: ensureOpenIdScope(
          scopes.filter((s) => s !== "users:token").join(" "),
        ),
      });
    }
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

                    {hasDeviceCode && (
                      <p className="mt-3 border-t border-zinc-700/50 pt-3 text-xs text-zinc-500">
                        Configure the third-party initiate login URL from{" "}
                        <strong className="text-zinc-400">Credentials &amp; URLs</strong>.
                      </p>
                    )}
                  </div>
                </label>
              </div>
            </>
          )}
        </div>

        {/* ── Grant Types (authorization_code implicit; refresh_token optional) ── */}
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-zinc-300">Grant Types</label>
            <p className="text-xs text-zinc-500 mt-0.5">
              Authorization Code + PKCE is always enabled for interactive apps.
            </p>
          </div>
          <div className="space-y-2">
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
