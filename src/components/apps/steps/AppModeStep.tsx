"use client";

import { useEffect } from "react";
import type { AppFormData } from "../AppWizard";
import { DEVICE_CODE_GRANT } from "@/lib/oidc/grants";
import { ensureOpenIdScope } from "@/lib/oidc/scopes";
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

function capabilityRowClass(enabled: boolean, readOnly: boolean): string {
  const base =
    "flex items-start gap-3 p-3 rounded-lg border transition-colors";
  if (readOnly) {
    return `${base} opacity-70`;
  }
  if (enabled) {
    return `${base} border-emerald-500/30 bg-emerald-500/5 cursor-pointer`;
  }
  return `${base} border-zinc-800 bg-zinc-800/20 hover:border-zinc-600 cursor-pointer`;
}

export default function AppModeStep({
  data,
  onChange,
  readOnly = false,
}: Readonly<Props>) {
  const scopes = data.allowedScopes.split(/\s+/).filter(Boolean);
  const hasDeviceCode = data.grantTypes.includes(DEVICE_CODE_GRANT);
  const hasSignJob = scopes.includes("sign:job");
  const hasRefreshToken = data.grantTypes.includes("refresh_token");
  const requiresIssueUserTokens =
    hasDeviceCode &&
    data.deviceThirdPartyInitiateLogin &&
    isValidInitiateLoginUri(data.initiateLoginUri);
  const hasIssueUserTokens = scopes.includes("users:token");

  const setAllowedScopes = (next: string) => {
    onChange({ allowedScopes: ensureOpenIdScope(next) });
  };

  useEffect(() => {
    if (scopes.includes("openid")) return;
    setAllowedScopes(data.allowedScopes);
  }, [data.allowedScopes, scopes, onChange]);

  const setGrantTypes = (next: string[]) => {
    onChange({ grantTypes: next });
  };

  useEffect(() => {
    if (!requiresIssueUserTokens || hasIssueUserTokens) return;
    setAllowedScopes([...scopes, "users:token"].join(" "));
  }, [hasIssueUserTokens, requiresIssueUserTokens, scopes]);

  const toggleRefreshToken = () => {
    if (readOnly) return;
    setGrantTypes(
      hasRefreshToken
        ? data.grantTypes.filter((v) => v !== "refresh_token")
        : [...data.grantTypes, "refresh_token"],
    );
  };

  const toggleSignJob = () => {
    if (readOnly) return;
    const next = hasSignJob
      ? scopes.filter((v) => v !== "sign:job")
      : [...scopes, "sign:job"];
    setAllowedScopes(next.join(" "));
  };

  const toggleDeviceCode = () => {
    if (readOnly || !data.backendDeviceHelper) return;
    if (hasDeviceCode) {
      onChange({
        grantTypes: data.grantTypes.filter((v) => v !== DEVICE_CODE_GRANT),
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
      const nextScopes = scopes.includes("users:token")
        ? scopes
        : [...scopes, "users:token"];
      onChange({
        backendDeviceHelper: true,
        allowedScopes: ensureOpenIdScope(nextScopes.join(" ")),
      });
    } else {
      onChange({
        backendDeviceHelper: false,
        grantTypes: data.grantTypes.filter((v) => v !== DEVICE_CODE_GRANT),
        initiateLoginUri: "",
        deviceThirdPartyInitiateLogin: false,
        allowedScopes: ensureOpenIdScope(
          scopes.filter((s) => s !== "users:token").join(" "),
        ),
      });
    }
  };

  return (
    <div className="space-y-4 border-t border-zinc-800 pt-8">
      <div>
        <h2 className="text-base font-semibold text-zinc-100">Capabilities</h2>
        <p className="text-sm text-zinc-500 mt-1">
          Enable the integration features your app needs.
        </p>
      </div>

      <div className="space-y-2">
        <label aria-label="Confidential M2M backend" className={capabilityRowClass(Boolean(data.backendDeviceHelper), readOnly)}>
          <input
            type="checkbox"
            checked={Boolean(data.backendDeviceHelper)}
            onChange={(e) => toggleHelper(e.target.checked)}
            disabled={readOnly}
            className="w-4 h-4 mt-0.5 rounded border-zinc-600 bg-zinc-800 text-emerald-500 focus:ring-emerald-500/40 shrink-0 disabled:opacity-50"
          />
          <div>
            <p className="text-sm font-medium text-zinc-200">Confidential M2M backend</p>
            <p className="text-xs text-zinc-500 mt-0.5">
              Provisions a confidential{" "}
              <code className="font-mono text-zinc-400">m2m_</code> client for
              server-to-server Builder APIs and token exchange testing.
            </p>
          </div>
        </label>

        {data.backendDeviceHelper ? (
          <label aria-label="Device / CLI login" className={capabilityRowClass(hasDeviceCode, readOnly)}>
            <input
              type="checkbox"
              checked={hasDeviceCode}
              onChange={toggleDeviceCode}
              disabled={readOnly}
              className="w-4 h-4 mt-0.5 rounded border-zinc-600 bg-zinc-800 text-emerald-500 focus:ring-emerald-500/40 shrink-0 disabled:opacity-50"
            />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-zinc-200">Device / CLI login</p>
              <p className="text-xs text-zinc-500 mt-0.5">
                Allow CLI tools, SDKs, and headless clients to authenticate via a
                user code on a secondary device.
              </p>
              {hasDeviceCode ? (
                <p className="mt-2 text-xs text-zinc-500">
                  Configure the third-party initiate login URL on{" "}
                  <strong className="text-zinc-400">Credentials &amp; URLs</strong>.
                </p>
              ) : null}
            </div>
          </label>
        ) : null}

        <label aria-label="Payment signing" className={capabilityRowClass(hasSignJob, readOnly)}>
          <input
            type="checkbox"
            checked={hasSignJob}
            onChange={toggleSignJob}
            disabled={readOnly}
            className="w-4 h-4 mt-0.5 rounded border-zinc-600 bg-zinc-800 text-emerald-500 focus:ring-emerald-500/40 shrink-0 disabled:opacity-50"
          />
          <div>
            <p className="text-sm font-medium text-zinc-200">Payment signing</p>
            <p className="text-xs text-zinc-500 mt-0.5">
              Access remote signer endpoints, including discovery and payment signing.
            </p>
          </div>
        </label>

        <label aria-label="Refresh tokens" className={capabilityRowClass(hasRefreshToken, readOnly)}>
          <input
            type="checkbox"
            checked={hasRefreshToken}
            onChange={toggleRefreshToken}
            disabled={readOnly}
            className="w-4 h-4 mt-0.5 rounded border-zinc-600 bg-zinc-800 text-emerald-500 focus:ring-emerald-500/40 shrink-0 disabled:opacity-50"
          />
          <div>
            <p className="text-sm font-medium text-zinc-200">Refresh tokens</p>
            <p className="text-xs text-zinc-500 mt-0.5">
              Allow direct refresh at the token endpoint after the initial interactive
              sign-in.
            </p>
          </div>
        </label>
      </div>
    </div>
  );
}
