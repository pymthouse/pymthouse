"use client";

import { useState } from "react";
import { type AppBranding, getDefaultBranding } from "@/platform/oidc/branding-shared";

interface ConsentFormProps {
  uid: string;
  branding?: AppBranding;
}

export default function ConsentForm({ uid, branding = getDefaultBranding() }: ConsentFormProps) {
  const [loading, setLoading] = useState(false);

  function submitConsent(action: "approve" | "deny") {
    setLoading(true);

    // Submit a native form so the browser follows the server-issued 302 directly.
    // No client-side URL handling — the redirect destination never touches JavaScript.
    const form = document.createElement("form");
    form.method = "POST";
    form.action = `/api/v1/oidc/interaction/${uid}`;

    const input = document.createElement("input");
    input.type = "hidden";
    input.name = "action";
    input.value = action;
    form.appendChild(input);

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
          disabled={loading}
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
