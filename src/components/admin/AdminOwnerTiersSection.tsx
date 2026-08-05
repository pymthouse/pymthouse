"use client";

import { useCallback, useEffect, useState } from "react";

import {
  sanitizeUsdCentsInput,
  usdCentsDisplayToMicros,
  usdMicrosToCentsDisplay,
} from "@/lib/format-usd-micros";

type Tier = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  monthlyFeeUsd: string;
  includedUsdMicros: string;
  overageRateUsd: string | null;
  sortOrder: number;
  active: boolean;
  openmeterPlanId: string | null;
  lastSyncedAt: string | null;
};

const emptyDraft = {
  key: "pymthouse_owner_paid_",
  name: "",
  description: "",
  monthlyFeeUsd: "20.00",
  includedDisplay: "5.00",
  sortOrder: "0",
};

function createTierMessage(body: {
  synced?: boolean;
  syncError?: string;
}): string {
  if (body.synced) {
    return "Tier created and synced to OpenMeter";
  }
  if (body.syncError) {
    return `Tier saved (sync: ${body.syncError})`;
  }
  return "Tier saved";
}

function updateTierMessage(body: {
  synced?: boolean;
  syncError?: string;
}): string {
  if (body.synced) {
    return "Tier updated and synced";
  }
  if (body.syncError) {
    return `Saved (sync: ${body.syncError})`;
  }
  return "Tier updated";
}

export default function AdminOwnerTiersSection() {
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editMonthlyFeeUsd, setEditMonthlyFeeUsd] = useState("");
  const [editIncludedDisplay, setEditIncludedDisplay] = useState("");
  const [editDescription, setEditDescription] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/admin/billing/owner-tiers");
      const body = (await res.json().catch(() => ({}))) as {
        tiers?: Tier[];
        error?: string;
      };
      if (!res.ok) {
        throw new Error(body.error || `Failed to load tiers (${res.status})`);
      }
      setTiers(body.tiers ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function startEditTier(tier: Tier) {
    setEditingId(tier.id);
    setEditName(tier.name);
    setEditMonthlyFeeUsd(tier.monthlyFeeUsd);
    setEditIncludedDisplay(usdMicrosToCentsDisplay(tier.includedUsdMicros));
    setEditDescription(tier.description ?? "");
    setError(null);
    setMessage(null);
  }

  function cancelEditTier() {
    setEditingId(null);
    setEditName("");
    setEditMonthlyFeeUsd("");
    setEditIncludedDisplay("");
    setEditDescription("");
  }

  async function saveEditTier(tier: Tier) {
    const nextName = editName.trim();
    if (!nextName) {
      setError("Name is required");
      return;
    }
    const nextFee = editMonthlyFeeUsd.trim();
    if (!nextFee) {
      setError("Monthly fee is required");
      return;
    }
    const nextIncluded = usdCentsDisplayToMicros(editIncludedDisplay);
    if (!nextIncluded) {
      setError("Enter a valid included allowance (e.g. 5.00)");
      return;
    }
    const nextDescription = editDescription.trim() || null;
    const prevDescription = tier.description?.trim() || null;

    const patch: Record<string, unknown> = {};
    if (nextName !== tier.name) patch.name = nextName;
    if (nextFee !== tier.monthlyFeeUsd) patch.monthlyFeeUsd = nextFee;
    if (nextIncluded !== tier.includedUsdMicros) {
      patch.includedUsdMicros = nextIncluded;
    }
    if (nextDescription !== prevDescription) {
      patch.description = nextDescription;
    }
    if (Object.keys(patch).length === 0) {
      cancelEditTier();
      return;
    }

    const ok = await patchTier(tier.id, patch);
    if (!ok) return;
    cancelEditTier();
  }

  async function createTier() {
    setCreating(true);
    setError(null);
    setMessage(null);
    try {
      const micros = usdCentsDisplayToMicros(draft.includedDisplay);
      if (!micros) {
        throw new Error("Enter a valid included allowance (e.g. 5.00)");
      }
      const res = await fetch("/api/v1/admin/billing/owner-tiers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: draft.key.trim().toLowerCase(),
          name: draft.name.trim(),
          description: draft.description.trim() || null,
          monthlyFeeUsd: draft.monthlyFeeUsd.trim(),
          includedUsdMicros: micros,
          sortOrder: Number(draft.sortOrder) || 0,
          active: true,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        synced?: boolean;
        syncError?: string;
      };
      if (!res.ok) {
        throw new Error(body.error || "Failed to create tier");
      }
      setDraft(emptyDraft);
      setMessage(createTierMessage(body));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  async function patchTier(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<boolean> {
    setBusyId(id);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/v1/admin/billing/owner-tiers/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        synced?: boolean;
        syncError?: string;
      };
      if (!res.ok) {
        throw new Error(body.error || "Failed to update tier");
      }
      setMessage(updateTierMessage(body));
      await load();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusyId(null);
    }
  }

  async function deactivate(id: string) {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/v1/admin/billing/owner-tiers/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || "Failed to deactivate");
      }
      setMessage("Tier deactivated");
      if (editingId === id) cancelEditTier();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="space-y-4 rounded-lg border border-white/10 bg-black/20 p-5">
      <h2 className="text-lg font-medium text-zinc-100">
        Owner Paid subscription tiers
      </h2>
      <p className="text-sm text-zinc-500">
        Flat monthly fee + included usage. Developers pick a tier on Upgrade.
        Keys must be <code className="text-zinc-300">pymthouse_owner_paid</code>{" "}
        or <code className="text-zinc-300">pymthouse_owner_paid_&lt;slug&gt;</code>.
        Edit an existing tier to change price, allowance, or checkout bullets —
        do not recreate the same key. The included-usage line on Upgrade is
        always generated from the live allowance (and overage rate). Saving fee
        or allowance syncs the OpenMeter plan.
      </p>

      {error ? (
        <p className="text-sm text-red-400" role="alert">
          {error}
        </p>
      ) : null}
      {message ? (
        <output className="block text-sm text-emerald-300">{message}</output>
      ) : null}

      {loading ? (
        <p className="text-sm text-zinc-500">Loading tiers…</p>
      ) : (
        <ul className="space-y-3">
          {tiers.map((tier) => {
            const isEditing = editingId === tier.id;
            const isBusy = busyId === tier.id;
            return (
              <li
                key={tier.id}
                className="rounded-md border border-white/10 bg-black/30 px-3 py-3 text-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    {isEditing ? (
                      <div className="grid max-w-xl gap-2 sm:grid-cols-2">
                        <label className="block sm:col-span-2">
                          <span className="text-xs text-zinc-500">Name</span>
                          <input
                            className="mt-1 w-full rounded-md border border-white/15 bg-black/40 px-2.5 py-1.5 text-sm text-zinc-100"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            disabled={isBusy}
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                void saveEditTier(tier);
                              }
                              if (e.key === "Escape") {
                                e.preventDefault();
                                cancelEditTier();
                              }
                            }}
                          />
                        </label>
                        <label className="block">
                          <span className="text-xs text-zinc-500">
                            Monthly fee (USD)
                          </span>
                          <input
                            className="mt-1 w-full rounded-md border border-white/15 bg-black/40 px-2.5 py-1.5 text-sm text-zinc-100"
                            value={editMonthlyFeeUsd}
                            onChange={(e) =>
                              setEditMonthlyFeeUsd(
                                sanitizeUsdCentsInput(e.target.value),
                              )
                            }
                            disabled={isBusy}
                          />
                        </label>
                        <label className="block">
                          <span className="text-xs text-zinc-500">
                            Included allowance (USD)
                          </span>
                          <input
                            className="mt-1 w-full rounded-md border border-white/15 bg-black/40 px-2.5 py-1.5 text-sm text-zinc-100"
                            value={editIncludedDisplay}
                            onChange={(e) =>
                              setEditIncludedDisplay(
                                sanitizeUsdCentsInput(e.target.value),
                              )
                            }
                            disabled={isBusy}
                          />
                        </label>
                        <label className="block sm:col-span-2">
                          <span className="text-xs text-zinc-500">
                            Checkout bullets (optional, one per line)
                          </span>
                          <textarea
                            className="mt-1 w-full rounded-md border border-white/15 bg-black/40 px-2.5 py-1.5 text-sm text-zinc-100"
                            rows={3}
                            value={editDescription}
                            onChange={(e) => setEditDescription(e.target.value)}
                            disabled={isBusy}
                            placeholder={
                              "Unlimited developer identities and API keys\nOverage billed per-call, no monthly cap"
                            }
                          />
                          <span className="mt-1 block text-[11px] text-zinc-600">
                            Included-usage line is generated from the allowance
                            above. These lines appear under it on Upgrade.
                          </span>
                        </label>
                        <p className="sm:col-span-2 font-mono text-xs text-zinc-500">
                          {tier.key}
                          {!tier.active ? (
                            <span className="ml-2 text-amber-400">inactive</span>
                          ) : null}
                        </p>
                      </div>
                    ) : (
                      <>
                        <p className="font-medium text-zinc-100">
                          {tier.name}{" "}
                          <span className="font-mono text-xs text-zinc-500">
                            {tier.key}
                          </span>
                          {!tier.active ? (
                            <span className="ml-2 text-xs text-amber-400">
                              inactive
                            </span>
                          ) : null}
                        </p>
                        <p className="mt-1 text-zinc-400">
                          ${tier.monthlyFeeUsd}/mo · $
                          {usdMicrosToCentsDisplay(tier.includedUsdMicros)}{" "}
                          included
                          {tier.openmeterPlanId
                            ? ` · OM ${tier.openmeterPlanId.slice(0, 8)}…`
                            : " · not synced"}
                        </p>
                      </>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {isEditing ? (
                      <>
                        <button
                          type="button"
                          className="rounded border border-emerald-500/30 px-2 py-1 text-xs text-emerald-300 disabled:opacity-50"
                          disabled={isBusy}
                          onClick={() => void saveEditTier(tier)}
                        >
                          Save & sync
                        </button>
                        <button
                          type="button"
                          className="rounded border border-white/10 px-2 py-1 text-xs text-zinc-300 disabled:opacity-50"
                          disabled={isBusy}
                          onClick={cancelEditTier}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="rounded border border-white/10 px-2 py-1 text-xs text-zinc-300 disabled:opacity-50"
                        disabled={isBusy}
                        onClick={() => startEditTier(tier)}
                      >
                        Edit
                      </button>
                    )}
                    <button
                      type="button"
                      className="rounded border border-white/10 px-2 py-1 text-xs text-zinc-300 disabled:opacity-50"
                      disabled={isBusy || !tier.active || isEditing}
                      onClick={() => void patchTier(tier.id, { sync: true })}
                    >
                      Re-sync
                    </button>
                    {tier.active ? (
                      <button
                        type="button"
                        className="rounded border border-amber-500/30 px-2 py-1 text-xs text-amber-300 disabled:opacity-50"
                        disabled={isBusy}
                        onClick={() => void deactivate(tier.id)}
                      >
                        Deactivate
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="rounded border border-emerald-500/30 px-2 py-1 text-xs text-emerald-300 disabled:opacity-50"
                        disabled={isBusy}
                        onClick={() =>
                          void patchTier(tier.id, { active: true, sync: true })
                        }
                      >
                        Activate
                      </button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="space-y-3 border-t border-white/10 pt-4">
        <h3 className="text-sm font-medium text-zinc-200">Add tier</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="text-zinc-400">Key</span>
            <input
              className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-sm"
              value={draft.key}
              onChange={(e) => setDraft({ ...draft, key: e.target.value })}
              disabled={creating}
            />
          </label>
          <label className="block text-sm">
            <span className="text-zinc-400">Name</span>
            <input
              className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              disabled={creating}
            />
          </label>
          <label className="block text-sm">
            <span className="text-zinc-400">Monthly fee (USD)</span>
            <input
              className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm"
              value={draft.monthlyFeeUsd}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  monthlyFeeUsd: sanitizeUsdCentsInput(e.target.value),
                })
              }
              disabled={creating}
            />
          </label>
          <label className="block text-sm">
            <span className="text-zinc-400">Included allowance (USD)</span>
            <input
              className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm"
              value={draft.includedDisplay}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  includedDisplay: sanitizeUsdCentsInput(e.target.value),
                })
              }
              disabled={creating}
            />
          </label>
          <label className="block text-sm">
            <span className="text-zinc-400">Sort order</span>
            <input
              className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm"
              inputMode="numeric"
              value={draft.sortOrder}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  sortOrder: e.target.value.replace(/[^\d-]/g, ""),
                })
              }
              disabled={creating}
            />
          </label>
        </div>
        <label className="block text-sm">
          <span className="text-zinc-400">
            Checkout bullets (optional, one per line)
          </span>
          <input
            className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm"
            value={draft.description}
            onChange={(e) =>
              setDraft({ ...draft, description: e.target.value })
            }
            disabled={creating}
            placeholder="Extra marketing bullets under the auto included-usage line"
          />
        </label>
        <button
          type="button"
          className="rounded-md bg-emerald-500/20 px-4 py-2 text-sm text-emerald-300 disabled:opacity-50"
          disabled={creating}
          onClick={() => void createTier()}
        >
          {creating ? "Creating…" : "Create & sync tier"}
        </button>
      </div>
    </section>
  );
}
