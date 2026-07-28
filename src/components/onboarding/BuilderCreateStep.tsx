"use client";

import { useState } from "react";
import { mintOwnerApiKey } from "@/components/apps/mint-owner-api-key";
import { useSession } from "next-auth/react";
import {
  DEFAULT_PUBLIC_GRANT_TYPES,
  DEVICE_CODE_GRANT,
} from "@/lib/oidc/grants";
import { DEFAULT_OIDC_SCOPES, ensureOpenIdScope } from "@/lib/oidc/scopes";

const fieldClass =
  "w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-emerald-500/40";

export default function BuilderCreateStep({
  busy: parentBusy,
  onCreated,
  onSoftSkip,
  onBack,
}: Readonly<{
  busy: boolean;
  onCreated: (clientId: string, apiKey: string | null, sdkToken: string | null) => void;
  onSoftSkip: () => void;
  onBack?: () => void;
}>) {
  const { data: session } = useSession();
  const [name, setName] = useState("");
  const [developerName, setDeveloperName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmSkip, setConfirmSkip] = useState(false);

  const busy = parentBusy || saving;

  async function handleSubmit(e: React.SyntheticEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;

    setError(null);
    setSaving(true);
    try {
      const res = await fetch("/api/v1/apps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmed,
          developerName: developerName.trim() || null,
          tokenEndpointAuthMethod: "none",
          redirectUris: [],
          allowedScopes: ensureOpenIdScope(`${DEFAULT_OIDC_SCOPES} users:token`),
          grantTypes: [...DEFAULT_PUBLIC_GRANT_TYPES, DEVICE_CODE_GRANT],
          backendDeviceHelper: true,
          confidentialWebHelper: false,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Failed to create app (${res.status})`);
      }
      const data = (await res.json()) as { id?: string; clientId?: string };
      const clientId = data.clientId || data.id;
      if (!clientId) throw new Error("App created but client id missing");

      const ownerId = (session?.user as Record<string, unknown> | undefined)?.id as
        | string
        | undefined;
      let apiKey: string | null = null;
      let sdkToken: string | null = null;
      if (ownerId) {
        try {
          const minted = await mintOwnerApiKey({
            clientId,
            ownerExternalUserId: ownerId,
          });
          apiKey = typeof minted.apiKey === "string" ? minted.apiKey : null;
          sdkToken = typeof minted.sdkToken === "string" ? minted.sdkToken : null;
        } catch {
          // App exists; key can be minted from credentials later.
        }
      }

      onCreated(clientId, apiKey, sdkToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed");
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-5">
      {error && (
        <div className="rounded-md border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">
          {error}
        </div>
      )}

      <div>
        <label htmlFor="onboarding-app-name" className="block text-sm font-medium text-zinc-200 mb-1.5">
          Application name <span className="text-red-400">*</span>
        </label>
        <input
          id="onboarding-app-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          required
          disabled={busy}
          className={fieldClass}
        />
      </div>

      <div>
        <label
          htmlFor="onboarding-developer-name"
          className="block text-sm font-medium text-zinc-200 mb-1.5"
        >
          Developer / organization name
        </label>
        <input
          id="onboarding-developer-name"
          type="text"
          value={developerName}
          onChange={(e) => setDeveloperName(e.target.value)}
          placeholder="Acme Inc."
          disabled={busy}
          className={fieldClass}
        />
      </div>

      <div className="flex flex-wrap gap-3 pt-1">
        <button
          type="submit"
          disabled={busy || name.trim().length === 0}
          className="rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {saving ? "Creating…" : "Create app & get key"}
        </button>
        {onBack && (
          <button
            type="button"
            disabled={busy}
            onClick={onBack}
            className="rounded-lg border border-zinc-700 px-4 py-2.5 text-sm text-zinc-300 hover:border-zinc-500 disabled:opacity-50"
          >
            Back
          </button>
        )}
      </div>

      <div className="border-t border-zinc-800 pt-4">
        {!confirmSkip ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirmSkip(true)}
            className="text-sm text-zinc-500 hover:text-zinc-300 disabled:opacity-50"
          >
            Skip for now
          </button>
        ) : (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 space-y-3">
            <p className="text-sm text-amber-200/90">
              Skipping setup limits you until you create an app. You&apos;ll need
              one before keys and signing work.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={onSoftSkip}
                className="rounded-md bg-amber-600/80 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-500"
              >
                Skip and continue
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmSkip(false)}
                className="rounded-md border border-zinc-600 px-3 py-1.5 text-xs text-zinc-300"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </form>
  );
}
