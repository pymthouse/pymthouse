"use client";

import type { AppFormData } from "@/domains/developer-apps/ui/app-editor";
import { docsDeviceFlowUrl } from "@/platform/docs/base-url";
import type { ScopeDefinition } from "@/platform/oidc/scopes";

interface Props {
  formData: AppFormData;
  hasDeviceCode: boolean;
  hasIssueUserTokens: boolean;
  usersTokenScope: ScopeDefinition;
  onToggleConfidential: (checked: boolean) => void;
  onToggleDeviceCode: () => void;
  onToggleIssueUserTokens: () => void;
}

export default function WizardOAuthCapabilitiesSection({
  formData,
  hasDeviceCode,
  hasIssueUserTokens,
  usersTokenScope,
  onToggleConfidential,
  onToggleDeviceCode,
  onToggleIssueUserTokens,
}: Props) {
  return (
    <div className="rounded-xl border border-zinc-700/80 bg-zinc-800/20 p-4 space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-zinc-100">OAuth capabilities</h2>
        <p className="text-xs text-zinc-500 mt-0.5">
          Device flow depends on a confidential (M2M) companion client in this product.
        </p>
      </div>

      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={Boolean(formData.backendDeviceHelper)}
          onChange={(e) => onToggleConfidential(e.target.checked)}
          className="w-4 h-4 mt-0.5 rounded border-zinc-600 bg-zinc-800 text-emerald-500 focus:ring-emerald-500/40 shrink-0"
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
            <code className="font-mono text-zinc-400">m2m_</code> client for
            server-to-server Builder APIs. Your public client stays unauthenticated for SDK
            / CLI device login.
          </p>
        </div>
      </label>

      <div>
        <label
          className={`flex items-start gap-3 ${
            formData.backendDeviceHelper ? "cursor-pointer" : "cursor-not-allowed opacity-60"
          }`}
        >
          <input
            type="checkbox"
            checked={hasDeviceCode}
            onChange={onToggleDeviceCode}
            disabled={!formData.backendDeviceHelper}
            className="w-4 h-4 mt-0.5 rounded border-zinc-600 bg-zinc-800 text-emerald-500 focus:ring-emerald-500/40 shrink-0 disabled:opacity-50"
          />
          <div>
            <p className="text-sm font-medium text-zinc-200">Enable Device Flow</p>
            <p className="text-xs text-zinc-500 mt-0.5">
              Allow CLI tools, SDKs, and headless clients to authorize via a user code.{" "}
              <a
                href={docsDeviceFlowUrl()}
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-500 hover:underline"
              >
                Device Flow documentation
              </a>
            </p>
          </div>
        </label>
        {!formData.backendDeviceHelper && (
          <p className="text-xs text-zinc-600 mt-1.5 ml-[26px]">
            Turn on Confidential client first.
          </p>
        )}
      </div>

      {formData.backendDeviceHelper && (
        <label className="flex items-start gap-3 cursor-pointer rounded-lg border border-zinc-700/70 bg-zinc-800/30 p-3">
          <input
            type="checkbox"
            checked={hasIssueUserTokens}
            onChange={onToggleIssueUserTokens}
            className="w-4 h-4 mt-0.5 rounded border-zinc-600 bg-zinc-800 text-emerald-500 focus:ring-emerald-500/40 shrink-0"
          />
          <div>
            <p className="text-sm font-medium text-zinc-200">{usersTokenScope.label}</p>
            <p className="text-xs text-zinc-500 mt-0.5">{usersTokenScope.description}</p>
          </div>
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
  );
}
