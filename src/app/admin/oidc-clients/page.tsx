"use client";

import { useState, useEffect } from "react";
import DashboardLayout from "@/components/DashboardLayout";

interface OidcClient {
  id: string;
  clientId: string;
  displayName: string;
  redirectUris: string[];
  allowedScopes: string[];
  grantTypes: string[];
  tokenEndpointAuthMethod: string;
  hasSecret: boolean;
  createdAt: string;
}

export default function AdminOidcClientsPage() {
  const [clients, setClients] = useState<OidcClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingClient, setEditingClient] = useState<OidcClient | null>(null);
  const [formData, setFormData] = useState<{
    displayName: string;
    redirectUris: string;
    allowedScopes: string;
  }>({
    displayName: "",
    redirectUris: "",
    allowedScopes: "",
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadClients();
  }, []);

  async function loadClients() {
    try {
      const res = await fetch("/api/v1/admin/oidc-clients");
      if (!res.ok) {
        let errMsg = `Failed to load clients (${res.status} ${res.statusText})`;
        try {
          const data = await res.json();
          if (data?.message) errMsg = data.message;
        } catch {
          /* ignore parse error */
        }
        throw new Error(errMsg);
      }
      const data = await res.json();
      setClients(data.clients || []);
    } catch (err) {
      console.error("Failed to load clients:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function startEdit(client: OidcClient) {
    setEditingClient(client);
    setFormData({
      displayName: client.displayName,
      redirectUris: client.redirectUris.join("\n"),
      allowedScopes: client.allowedScopes.join(" "),
    });
    setMessage(null);
  }

  function cancelEdit() {
    setEditingClient(null);
    setFormData({ displayName: "", redirectUris: "", allowedScopes: "" });
    setMessage(null);
  }

  async function saveEdit() {
    if (!editingClient) return;

    setSaving(true);
    setMessage(null);

    try {
      const updates = {
        displayName: formData.displayName.trim(),
        redirectUris: formData.redirectUris
          .split("\n")
          .map((u) => u.trim())
          .filter(Boolean),
        allowedScopes: formData.allowedScopes.trim(),
      };

      const res = await fetch("/api/v1/admin/oidc-clients", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: editingClient.clientId,
          updates,
        }),
      });

      if (res.ok) {
        setMessage("Client updated successfully");
        await loadClients();
        setTimeout(() => cancelEdit(), 1500);
      } else {
        const data = await res.json();
        setMessage(`Error: ${data.error || "Failed to update"}`);
      }
    } catch (err) {
      setMessage("Failed to connect to API");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <DashboardLayout>
        <div className="animate-pulse text-zinc-500 text-center py-12">
          Loading OIDC clients...
        </div>
      </DashboardLayout>
    );
  }

  if (error) {
    return (
      <DashboardLayout>
        <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/20 text-red-300 text-sm">
          {error}
        </div>
      </DashboardLayout>
    );
  }

  if (editingClient) {
    return (
      <DashboardLayout>
        <div className="mb-8">
          <button
            type="button"
            onClick={cancelEdit}
            className="text-sm text-zinc-400 hover:text-zinc-300 mb-4 flex items-center gap-2"
          >
            ← Back to clients
          </button>
          <h2 className="text-2xl font-bold tracking-tight">
            Edit OIDC Client
          </h2>
          <p className="text-zinc-500 mt-1">
            Editing {editingClient.clientId}
          </p>
        </div>

        <div className="max-w-2xl border border-zinc-800 rounded-xl p-6 bg-zinc-900/30">
          <div className="space-y-6">
            {/* Display Name */}
            <div>
              <label htmlFor="oidc-edit-display-name" className="block text-sm font-medium text-zinc-300 mb-2">
                Display Name
              </label>
              <input
                id="oidc-edit-display-name"
                type="text"
                value={formData.displayName}
                onChange={(e) =>
                  setFormData({ ...formData, displayName: e.target.value })
                }
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>

            {/* Redirect URIs */}
            <div>
              <label htmlFor="oidc-edit-redirect-uris" className="block text-sm font-medium text-zinc-300 mb-2">
                Redirect URIs
                <span className="text-zinc-500 font-normal ml-2">
                  (one per line)
                </span>
              </label>
              <textarea
                id="oidc-edit-redirect-uris"
                value={formData.redirectUris}
                onChange={(e) =>
                  setFormData({ ...formData, redirectUris: e.target.value })
                }
                rows={6}
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-zinc-100 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>

            {/* Allowed Scopes */}
            <div>
              <label htmlFor="oidc-edit-allowed-scopes" className="block text-sm font-medium text-zinc-300 mb-2">
                Allowed Scopes
                <span className="text-zinc-500 font-normal ml-2">
                  (space-separated)
                </span>
              </label>
              <input
                id="oidc-edit-allowed-scopes"
                type="text"
                value={formData.allowedScopes}
                onChange={(e) =>
                  setFormData({ ...formData, allowedScopes: e.target.value })
                }
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-zinc-100 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>

            {/* Client Info (read-only) */}
            <div className="pt-4 border-t border-zinc-800 space-y-3">
              <div>
                <span className="text-sm text-zinc-500">Client ID:</span>
                <code className="ml-2 text-sm text-zinc-300 font-mono">
                  {editingClient.clientId}
                </code>
              </div>
              <div>
                <span className="text-sm text-zinc-500">Auth Method:</span>
                <code className="ml-2 text-sm text-zinc-300">
                  {editingClient.tokenEndpointAuthMethod}
                </code>
              </div>
              <div>
                <span className="text-sm text-zinc-500">Grant Types:</span>
                <code className="ml-2 text-sm text-zinc-300">
                  {editingClient.grantTypes.join(", ")}
                </code>
              </div>
              <div>
                <span className="text-sm text-zinc-500">Has Secret:</span>
                <span className="ml-2 text-sm text-zinc-300">
                  {editingClient.hasSecret ? "Yes" : "No"}
                </span>
              </div>
            </div>

            {/* Message */}
            {message && (
              <div
                className={`p-3 rounded-lg text-sm ${
                  message.startsWith("Error")
                    ? "bg-red-500/10 text-red-400 border border-red-500/20"
                    : "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                }`}
              >
                {message}
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-3 pt-4">
              <button
                type="button"
                onClick={saveEdit}
                disabled={saving}
                className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? "Saving..." : "Save Changes"}
              </button>
              <button
                type="button"
                onClick={cancelEdit}
                disabled={saving}
                className="px-4 py-2 bg-zinc-800 text-zinc-300 rounded-lg text-sm font-medium hover:bg-zinc-700 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="mb-8">
        <h2 className="text-2xl font-bold tracking-tight">OIDC Clients</h2>
        <p className="text-zinc-500 mt-1">
          Manage all registered OIDC clients
        </p>
      </div>

      <div className="space-y-3">
        {clients.map((client) => (
          <ClientCard
            key={client.id}
            client={client}
            onEdit={startEdit}
          />
        ))}
      </div>
    </DashboardLayout>
  );
}

function ClientCard({
  client,
  onEdit,
}: Readonly<{
  client: OidcClient;
  onEdit: (client: OidcClient) => void;
}>) {
  return (
    <div className="border border-zinc-800 rounded-xl p-5 bg-zinc-900/30">
      <div className="flex items-start justify-between mb-4">
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-2">
            <h4 className="text-base font-semibold text-zinc-200">
              {client.displayName}
            </h4>
            {client.hasSecret && (
              <span className="px-2 py-0.5 bg-emerald-500/20 text-emerald-400 rounded-full text-xs font-medium">
                Secured
              </span>
            )}
          </div>
          <code className="text-sm text-zinc-400 font-mono">
            {client.clientId}
          </code>
        </div>
        <button
          type="button"
          onClick={() => onEdit(client)}
          className="px-3 py-1.5 bg-zinc-800 text-zinc-300 rounded-lg text-sm hover:bg-zinc-700 transition-colors"
        >
          Edit
        </button>
      </div>

      <div className="grid grid-cols-2 gap-4 text-sm">
        <div>
          <span className="text-zinc-500">Auth Method:</span>
          <div className="text-zinc-300 font-mono mt-1">
            {client.tokenEndpointAuthMethod}
          </div>
        </div>
        <div>
          <span className="text-zinc-500">Grant Types:</span>
          <div className="text-zinc-300 mt-1">
            {client.grantTypes.join(", ")}
          </div>
        </div>
        <div className="col-span-2">
          <span className="text-zinc-500">Scopes:</span>
          <div className="text-zinc-300 mt-1 flex flex-wrap gap-1">
            {client.allowedScopes.map((scope) => (
              <span
                key={scope}
                className="px-2 py-0.5 bg-zinc-800 rounded text-xs font-mono"
              >
                {scope}
              </span>
            ))}
          </div>
        </div>
        <div className="col-span-2">
          <span className="text-zinc-500">Redirect URIs:</span>
          <div className="text-zinc-400 mt-1 space-y-1 font-mono text-xs">
            {client.redirectUris.length > 0 ? (
              client.redirectUris.map((uri, i) => (
                <div key={i} className="truncate">
                  {uri}
                </div>
              ))
            ) : (
              <div className="text-zinc-600">None configured</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
