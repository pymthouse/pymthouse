"use client";

import { useState } from "react";
import { type AppBranding, getDefaultBranding } from "@/lib/oidc/branding-shared";
import { oidcInteractionSubmitPath } from "@/lib/oidc/interaction-path";

export type ConsentAppOption = {
  publicClientId: string;
  name: string;
};

interface ConsentFormProps {
  uid: string;
  branding?: AppBranding;
  /** When set, user must pick a Builder app before approving (MCP OAuth). */
  appOptions?: ConsentAppOption[];
  requireAppSelection?: boolean;
}

export default function ConsentForm({
  uid,
  branding = getDefaultBranding(),
  appOptions = [],
  requireAppSelection = false,
}: Readonly<ConsentFormProps>) {
  const [loading, setLoading] = useState(false);
  const [selectedApp, setSelectedApp] = useState(
    appOptions.length === 1 ? appOptions[0].publicClientId : "",
  );
  const [error, setError] = useState<string | null>(null);

  function submitConsent(action: "approve" | "deny") {
    if (action === "approve" && requireAppSelection && !selectedApp) {
      setError("Select a Builder app to continue.");
      return;
    }
    setError(null);
    setLoading(true);

    const form = document.createElement("form");
    form.method = "POST";
    form.action = oidcInteractionSubmitPath(uid);

    const actionInput = document.createElement("input");
    actionInput.type = "hidden";
    actionInput.name = "action";
    actionInput.value = action;
    form.appendChild(actionInput);

    if (action === "approve" && selectedApp) {
      const appInput = document.createElement("input");
      appInput.type = "hidden";
      appInput.name = "app_client_id";
      appInput.value = selectedApp;
      form.appendChild(appInput);
    }

    document.body.appendChild(form);
    form.submit();
  }

  const handleAuthorize = () => submitConsent("approve");
  const handleDeny = () => submitConsent("deny");

  const safePrimaryColor = /^#[0-9a-fA-F]{6}$/.test(branding.primaryColor)
    ? branding.primaryColor
    : "#10b981";

  return (
    <div className="space-y-3">
      {requireAppSelection && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-4 mb-2">
          <label
            htmlFor="mcp-app-select"
            className="text-xs font-medium uppercase tracking-[0.18em] text-zinc-500"
          >
            Builder app
          </label>
          <p className="text-sm text-zinc-400 mt-2 mb-3">
            Claude will use Livepeer MCP as this app. Network tools and billing
            follow the app you select.
          </p>
          {appOptions.length === 0 ? (
            <p className="text-sm text-amber-300">
              You do not own any Builder apps yet. Create an app in the dashboard,
              then reconnect Claude.
            </p>
          ) : (
            <select
              id="mcp-app-select"
              value={selectedApp}
              onChange={(e) => setSelectedApp(e.target.value)}
              disabled={loading}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2.5 text-sm text-zinc-100 focus:outline-none focus:ring-1 focus:ring-emerald-500/40"
            >
              <option value="">Select an app…</option>
              {appOptions.map((app) => (
                <option key={app.publicClientId} value={app.publicClientId}>
                  {app.name} ({app.publicClientId})
                </option>
              ))}
            </select>
          )}
          {error && <p className="text-sm text-red-300 mt-2">{error}</p>}
        </div>
      )}

      <div className="flex gap-3">
        <button
          type="button"
          onClick={handleDeny}
          disabled={loading}
          className="flex-1 px-4 py-2.5 text-sm font-medium text-zinc-300 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors disabled:opacity-50"
        >
          Deny
        </button>
        <button
          type="button"
          onClick={handleAuthorize}
          disabled={
            loading ||
            (requireAppSelection &&
              (appOptions.length === 0 || !selectedApp))
          }
          className="flex-1 px-4 py-2.5 text-sm font-medium text-white rounded-lg transition-colors disabled:opacity-50 flex items-center justify-center gap-2 hover:opacity-90"
          style={{ backgroundColor: safePrimaryColor }}
        >
          {loading ? (
            <>
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                  fill="none"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              Continuing...
            </>
          ) : (
            "Authorize and Continue"
          )}
        </button>
      </div>
    </div>
  );
}
