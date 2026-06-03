"use client";

import { useEffect } from "react";
import type { AppFormData } from "../AppWizard";
import {
  AUTHORIZATION_CODE_GRANT,
  DEVICE_CODE_GRANT,
  ensureAuthorizationCodeGrant,
} from "@/lib/oidc/grants";
import { ensureOpenIdScope, OIDC_SCOPES } from "@/lib/oidc/scopes";

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
  // `users:token` must be locked by the confidential client path, not by whether
  // third-party initiation is currently enabled/configured.
  const requiresIssueUserTokens = Boolean(data.backendDeviceHelper);
  const hasIssueUserTokens = scopes.includes("users:token");

  // Only show users:token when M2M is on; openid and sign:job are always included
  // implicitly and don't need to be surfaced in the UI.
  const usersTokenScope = OIDC_SCOPES.find((s) => s.value === "users:token");

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

  useEffect(() => {
    if (!requiresIssueUserTokens || hasIssueUserTokens) return;
    setAllowedScopes([...scopes, "users:token"].join(" "));
  }, [hasIssueUserTokens, requiresIssueUserTokens, scopes]);

  const toggleDeviceCode = () => {
    if (readOnly) return;
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
        // Device Authorization Flow can remain enabled without the confidential client.
        grantTypes: data.grantTypes,
        // Third-party initiation is only meaningful on the confidential-client path.
        initiateLoginUri: "",
        deviceThirdPartyInitiateLogin: false,
        allowedScopes: ensureOpenIdScope(
          scopes.filter((s) => s !== "users:token").join(" "),
        ),
      });
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-zinc-100 mb-1">Auth & Scopes</h2>
        <p className="text-sm text-zinc-500">
          Configure grants and scopes for this provider app.
        </p>
      </div>

      <div className="space-y-4 border-t border-zinc-800 pt-6">
        {/* Device Authorization Flow */}
        <div className={`rounded-xl border bg-zinc-800/20 p-4 space-y-3 ${
          hasDeviceCode ? "border-emerald-500/30" : "border-zinc-700/80"
        }`}>
          <label className={`flex items-start gap-3 ${readOnly ? "cursor-default" : "cursor-pointer"}`}>
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
                Allow CLI tools, SDKs, and headless clients to authenticate via a user code on a secondary device.
              </p>

              {hasDeviceCode && data.backendDeviceHelper && (
                <p className="mt-3 border-t border-zinc-700/50 pt-3 text-xs text-zinc-500">
                  Configure the third-party initiate login URL from{" "}
                  <strong className="text-zinc-400">Credentials &amp; URLs</strong>.
                </p>
              )}
            </div>
          </label>
        </div>

        {/* Machine-to-Machine */}
        <div className={`rounded-xl border bg-zinc-800/20 p-4 space-y-3 ${
          data.backendDeviceHelper ? "border-emerald-500/30" : "border-zinc-700/80"
        }`}>
          <label className={`flex items-start gap-3 ${readOnly ? "cursor-default" : "cursor-pointer"}`}>
            <input
              type="checkbox"
              checked={Boolean(data.backendDeviceHelper)}
              onChange={(e) => toggleHelper(e.target.checked)}
              disabled={readOnly}
              className="w-4 h-4 mt-0.5 rounded border-zinc-600 bg-zinc-800 text-emerald-500 focus:ring-emerald-500/40 shrink-0 disabled:opacity-50"
            />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-zinc-200">
                Machine-to-Machine{" "}
                <span className="text-[10px] font-normal text-zinc-500 uppercase tracking-wide">
                  (confidential client)
                </span>
              </p>
              <p className="text-xs text-zinc-500 mt-1">
                Provisions a confidential <code className="font-mono text-zinc-400">m2m_</code> client
                for Builder APIs and device approval token exchange.
              </p>
            </div>
          </label>

          {data.backendDeviceHelper && (
            <div className="rounded-lg border border-zinc-700/70 bg-zinc-800/30 px-3 py-2 text-xs text-zinc-400">
              Companion client always includes{" "}
              <code className="font-mono text-zinc-300">users:token users:write device:approve</code>, plus{" "}
              <code className="font-mono text-zinc-300">sign:job</code> and/or{" "}
              <code className="font-mono text-zinc-300">users:read</code> when your public app has those scopes.
            </div>
          )}
        </div>

        {/* Issue User Tokens scope — only surfaced when M2M enables it */}
        {data.backendDeviceHelper && usersTokenScope && (
          <div className="space-y-2 pt-2">
            <label className="block text-sm font-medium text-zinc-300">Scopes</label>
            <label className="flex items-center gap-3 p-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 opacity-70 cursor-not-allowed">
              <input
                type="checkbox"
                checked={scopes.includes("users:token")}
                onChange={() => undefined}
                disabled
                className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 text-emerald-500 focus:ring-emerald-500/40 shrink-0"
              />
              <div>
                <p className="text-sm font-medium text-zinc-200">
                  {usersTokenScope.label}
                  <span className="ml-1.5 text-[10px] font-normal text-zinc-500 uppercase tracking-wide">
                    (required)
                  </span>
                </p>
                <p className="text-xs text-zinc-500">{usersTokenScope.description}</p>
              </div>
            </label>
          </div>
        )}
      </div>
    </div>
  );
}
