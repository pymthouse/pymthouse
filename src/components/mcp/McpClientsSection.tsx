"use client";

import { useCallback, useEffect, useState } from "react";

import CopyIdButton from "@/components/apps/CopyIdButton";
import type { McpCatalogClientStatus } from "@/lib/mcp/catalog";
import { PLATFORM_DEFAULT_USAGE_DISPLAY_NAME } from "@/lib/platform-default-labels";

export default function McpClientsSection() {
  const [clients, setClients] = useState<McpCatalogClientStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/v1/me/mcp-clients");
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      throw new Error(body.error || "Failed to load MCP clients");
    }
    const body = (await response.json()) as {
      clients?: McpCatalogClientStatus[];
    };
    setClients(body.clients ?? []);
  }, []);

  useEffect(() => {
    void load().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : "Failed to load MCP clients");
    });
  }, [load]);

  async function mutate(id: string, method: "POST" | "DELETE") {
    setPendingId(id);
    setError(null);
    try {
      const response = await fetch(
        method === "POST"
          ? "/api/v1/me/mcp-clients"
          : `/api/v1/me/mcp-clients/${encodeURIComponent(id)}`,
        {
          method,
          headers:
            method === "POST" ? { "Content-Type": "application/json" } : undefined,
          body: method === "POST" ? JSON.stringify({ id }) : undefined,
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error || "Request failed");
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <section className="mb-8">
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-zinc-100">MCP clients</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Connect Claude, Hermes, Codex, ChatGPT, or Cursor. Paste only the MCP
          URL — no headers and no API key. Usage bills to{" "}
          {PLATFORM_DEFAULT_USAGE_DISPLAY_NAME}, the same as a personal network
          key.
        </p>
      </div>

      {error ? (
        <p className="mb-3 text-sm text-red-300">{error}</p>
      ) : null}

      <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40">
        <ul className="divide-y divide-zinc-800">
          {(clients ?? placeholderRows()).map((client) => (
            <li
              key={client.id}
              className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-zinc-100">{client.name}</p>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                      client.linked
                        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                        : "border-zinc-700 bg-zinc-800 text-zinc-400"
                    }`}
                  >
                    {client.linked ? "Linked" : "Not linked"}
                  </span>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <code className="truncate text-xs text-zinc-400">
                    {client.mcpUrl || "https://…/api/v1/mcp"}
                  </code>
                  {client.mcpUrl ? (
                    <CopyIdButton value={client.mcpUrl} label="Copy MCP URL" />
                  ) : null}
                </div>
              </div>
              <div className="shrink-0">
                {client.linked ? (
                  <button
                    type="button"
                    disabled={pendingId === client.id || !clients}
                    onClick={() => void mutate(client.id, "DELETE")}
                    className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
                  >
                    {pendingId === client.id ? "Unlinking…" : "Unlink"}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={pendingId === client.id || !clients}
                    onClick={() => void mutate(client.id, "POST")}
                    className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                  >
                    {pendingId === client.id ? "Linking…" : "Link"}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function placeholderRows(): McpCatalogClientStatus[] {
  return [
    { id: "claude", name: "Claude", linked: false, mcpUrl: "", staticClientId: "" },
    { id: "hermes", name: "Hermes", linked: false, mcpUrl: "", staticClientId: "" },
    { id: "codex", name: "Codex", linked: false, mcpUrl: "", staticClientId: "" },
    { id: "chatgpt", name: "ChatGPT", linked: false, mcpUrl: "", staticClientId: "" },
    { id: "cursor", name: "Cursor", linked: false, mcpUrl: "", staticClientId: "" },
  ];
}
