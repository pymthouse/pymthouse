"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import DashboardLayout from "@/components/DashboardLayout";
import AppSectionBreadcrumb from "@/components/apps/AppSectionBreadcrumb";
import PipelineModelPicker from "@/components/PipelineModelPicker";

import type { PipelineCatalogEntry } from "@/components/PipelineModelPicker";
import type { DiscoveryPolicy } from "@/shared/discovery/discovery-plans";

interface ProfileRow {
  id: string;
  name: string;
  policy: DiscoveryPolicy | null;
  capabilities: Array<{
    pipeline: string;
    modelId: string;
    discoveryPolicy: DiscoveryPolicy | null;
  }>;
}

function formatDiscoveryPolicyShort(p: DiscoveryPolicy | null | undefined): string | null {
  if (!p || typeof p !== "object") return null;
  const parts: string[] = [];
  if (p.topN != null) parts.push(`topN=${p.topN}`);
  if (p.sortBy) parts.push(`sort=${p.sortBy}`);
  if (p.slaMinScore != null) parts.push(`slaMin=${p.slaMinScore}`);
  if (p.filters && Object.keys(p.filters).length > 0) parts.push("filters");
  return parts.length ? parts.join(", ") : null;
}

async function readFetchJson(res: Response): Promise<{
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}> {
  const text = await res.text();
  let body: Record<string, unknown> = {};
  if (text.trim()) {
    try {
      const parsed: unknown = JSON.parse(text);
      body =
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
    } catch {
      body = {};
    }
  }
  return { ok: res.ok, status: res.status, body };
}

function buildDiscoveryPolicyFromForm(form: {
  discoveryTopN: string;
  discoverySortBy: string;
  discoverySlaMin: string;
  discoveryGpuRamGbMin: string;
  discoveryGpuRamGbMax: string;
  discoveryPriceMax: string;
  discoveryMaxAvgLatencyMs: string;
  discoveryMaxSwapRatio: string;
}): { policy: DiscoveryPolicy; hasDiscovery: boolean } {
  const filters: NonNullable<DiscoveryPolicy["filters"]> = {};
  if (form.discoveryGpuRamGbMin.trim()) {
    const n = Number(form.discoveryGpuRamGbMin);
    if (Number.isFinite(n) && n >= 0) filters.gpuRamGbMin = n;
  }
  if (form.discoveryGpuRamGbMax.trim()) {
    const n = Number(form.discoveryGpuRamGbMax);
    if (Number.isFinite(n) && n >= 0) filters.gpuRamGbMax = n;
  }
  if (form.discoveryPriceMax.trim()) {
    const n = Number(form.discoveryPriceMax);
    if (Number.isFinite(n) && n >= 0) filters.priceMax = n;
  }
  if (form.discoveryMaxAvgLatencyMs.trim()) {
    const n = Number(form.discoveryMaxAvgLatencyMs);
    if (Number.isFinite(n) && n >= 0) filters.maxAvgLatencyMs = n;
  }
  if (form.discoveryMaxSwapRatio.trim()) {
    const n = Number(form.discoveryMaxSwapRatio);
    if (Number.isFinite(n) && n >= 0 && n <= 1) filters.maxSwapRatio = n;
  }

  const discoveryPolicy: DiscoveryPolicy = {};
  if (form.discoveryTopN.trim()) {
    const n = parseInt(form.discoveryTopN, 10);
    if (Number.isInteger(n) && n >= 1 && n <= 1000) discoveryPolicy.topN = n;
  }
  if (form.discoverySortBy.trim()) {
    discoveryPolicy.sortBy = form.discoverySortBy.trim() as DiscoveryPolicy["sortBy"];
  }
  if (form.discoverySlaMin.trim()) {
    const n = Number(form.discoverySlaMin);
    if (Number.isFinite(n) && n >= 0 && n <= 1) discoveryPolicy.slaMinScore = n;
  }
  if (Object.keys(filters).length > 0) {
    discoveryPolicy.filters = filters;
  }
  const hasDiscovery = Boolean(
    discoveryPolicy.topN != null ||
      discoveryPolicy.sortBy != null ||
      discoveryPolicy.slaMinScore != null ||
      (discoveryPolicy.filters && Object.keys(discoveryPolicy.filters).length > 0),
  );
  return { policy: discoveryPolicy, hasDiscovery };
}

export default function AppDiscoveryProfilesPage() {
  const { id } = useParams<{ id: string }>();
  const [appName, setAppName] = useState("App");
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [catalog, setCatalog] = useState<PipelineCatalogEntry[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [canEdit, setCanEdit] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    capabilityKeys: [] as string[],
    discoveryTopN: "",
    discoverySortBy: "",
    discoverySlaMin: "",
    discoveryGpuRamGbMin: "",
    discoveryGpuRamGbMax: "",
    discoveryPriceMax: "",
    discoveryMaxAvgLatencyMs: "",
    discoveryMaxSwapRatio: "",
  });

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      fetch(`/api/v1/apps/${id}`).then(readFetchJson),
      fetch(`/api/v1/apps/${id}/discovery-profiles`).then(readFetchJson),
    ])
      .then(([appWrap, profWrap]) => {
        const app = appWrap.body;
        setAppName((typeof app.name === "string" ? app.name : "") || "App");
        setCanEdit(app.canEdit !== false);
        if (profWrap.ok && Array.isArray(profWrap.body.profiles)) {
          setProfiles(profWrap.body.profiles as ProfileRow[]);
          setError(null);
        } else {
          setProfiles([]);
          setError(
            typeof profWrap.body.error === "string"
              ? profWrap.body.error
              : `Could not load profiles (HTTP ${profWrap.status})`,
          );
        }
      })
      .catch((err) => {
        setProfiles([]);
        setError(err instanceof Error ? err.message : "Failed to load profiles");
      })
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    fetch("/api/v1/pipeline-catalog")
      .then(readFetchJson)
      .then(({ ok, status, body }) => {
        const cat = body.catalog;
        if (Array.isArray(cat) && cat.length > 0) {
          const entries = cat as PipelineCatalogEntry[];
          setCatalog(entries);
          setForm((prev) => ({
            ...prev,
            capabilityKeys: entries.map((e) => e.id),
          }));
        } else if (typeof body.error === "string") {
          setCatalogError(body.error);
        } else if (!ok) {
          setCatalogError(`Pipeline catalog unavailable (HTTP ${status})`);
        }
      })
      .catch(() => setCatalogError("NaaP catalog unavailable"));
  }, []);

  const createProfile = async () => {
    if (!canEdit || !form.name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const { policy, hasDiscovery } = buildDiscoveryPolicyFromForm(form);
      const capabilities = form.capabilityKeys.map((key) => {
        const sep = key.indexOf("|");
        const isWildcard = sep === -1;
        const pipeline = isWildcard ? key : key.slice(0, sep);
        const modelId = isWildcard ? "*" : key.slice(sep + 1);
        return {
          pipeline,
          modelId,
          discoveryPolicy: hasDiscovery ? { ...policy } : null,
        };
      });

      const res = await fetch(`/api/v1/apps/${id}/discovery-profiles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          policy: hasDiscovery ? policy : null,
          capabilities: hasDiscovery && capabilities.length > 0 ? capabilities : [],
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error ?? `Failed to create profile (${res.status})`);
        return;
      }
      setForm({
        name: "",
        capabilityKeys: catalog.length > 0 ? catalog.map((e) => e.id) : [],
        discoveryTopN: "",
        discoverySortBy: "",
        discoverySlaMin: "",
        discoveryGpuRamGbMin: "",
        discoveryGpuRamGbMax: "",
        discoveryPriceMax: "",
        discoveryMaxAvgLatencyMs: "",
        discoveryMaxSwapRatio: "",
      });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create profile");
    } finally {
      setSaving(false);
    }
  };

  const deleteProfile = async (profileId: string) => {
    if (!canEdit) return;
    try {
      const res = await fetch(`/api/v1/apps/${id}/discovery-profiles/${profileId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error ?? `Failed to delete (${res.status})`);
        return;
      }
      load();
    } catch (err) {
      setError(`Network error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <DashboardLayout>
      <div className="mb-8">
        <AppSectionBreadcrumb appId={id} appName={appName} current="discovery-profiles" />
        <h1 className="text-2xl font-bold text-zinc-100">Discovery profiles</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Reusable orchestrator ranking defaults for {appName}. Link a profile from{" "}
          <Link href={`/apps/${id}/plans`} className="text-emerald-500/90 hover:underline">
            billing plans
          </Link>
          .
        </p>
        {!canEdit && (
          <p className="text-sm text-amber-400/90 mt-2">
            View only — only platform or app administrators can create or delete profiles.
          </p>
        )}
        {error && (
          <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 mt-2">
            {error}
          </p>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-[400px_1fr]">
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-6 space-y-4">
          <h2 className="text-lg font-semibold text-zinc-100">New profile</h2>
          <div>
            <label htmlFor="profile-name" className="block text-xs text-zinc-500 mb-1">
              Profile name
            </label>
            <input
              id="profile-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Profile name"
              disabled={!canEdit}
              className="w-full px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-sm text-zinc-100 disabled:opacity-50"
            />
          </div>

          <div className="border-t border-zinc-800 pt-4 space-y-3">
            <h3 className="text-sm font-medium text-zinc-300">Pipeline / model scope</h3>
            {catalogError && (
              <p className="text-xs text-amber-400">{catalogError} — you can still save plan-level policy only.</p>
            )}
            {catalog.length > 0 ? (
              <div>
                <label className="block text-xs text-zinc-500 mb-1">
                  Pipelines &amp; models
                  <span className="ml-1 text-zinc-600 normal-case font-normal">
                    — per-row overrides use the same policy as below when discovery fields are set
                  </span>
                </label>
                <PipelineModelPicker
                  catalog={catalog}
                  values={form.capabilityKeys}
                  onChange={(keys) => setForm({ ...form, capabilityKeys: keys })}
                  disabled={!canEdit}
                />
              </div>
            ) : (
              <p className="text-xs text-zinc-500 italic">No catalog — only plan-level defaults apply.</p>
            )}
            {form.capabilityKeys.length > 0 && (
              <p className="text-xs text-zinc-500">
                {form.capabilityKeys.length}{" "}
                {form.capabilityKeys.length !== 1 ? "rows" : "row"} with optional per-capability discovery (same
                policy).
              </p>
            )}
          </div>

          <div className="border-t border-zinc-800 pt-4 space-y-2">
            <h3 className="text-sm font-medium text-zinc-300">Discovery defaults</h3>
            <p className="text-[11px] text-zinc-600">Optional. Used by NaaP-style orchestrator discovery.</p>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label htmlFor="discovery-topN" className="block text-[11px] text-zinc-500 mb-0.5">
                  topN
                </label>
                <input
                  id="discovery-topN"
                  type="number"
                  min={1}
                  max={1000}
                  value={form.discoveryTopN}
                  onChange={(e) => setForm({ ...form, discoveryTopN: e.target.value })}
                  placeholder="e.g. 10"
                  disabled={!canEdit}
                  className="w-full px-2 py-1.5 bg-zinc-800/50 border border-zinc-700 rounded text-xs text-zinc-100 disabled:opacity-50"
                />
              </div>
              <div>
                <label htmlFor="discovery-sortBy" className="block text-[11px] text-zinc-500 mb-0.5">
                  sortBy
                </label>
                <select
                  id="discovery-sortBy"
                  value={form.discoverySortBy}
                  onChange={(e) => setForm({ ...form, discoverySortBy: e.target.value })}
                  disabled={!canEdit}
                  className="w-full px-2 py-1.5 bg-zinc-800/50 border border-zinc-700 rounded text-xs text-zinc-100 disabled:opacity-50"
                >
                  <option value="">—</option>
                  <option value="slaScore">slaScore</option>
                  <option value="latency">latency</option>
                  <option value="price">price</option>
                  <option value="swapRate">swapRate</option>
                  <option value="avail">avail</option>
                </select>
              </div>
              <div className="col-span-2">
                <label htmlFor="discovery-sla-min" className="block text-[11px] text-zinc-500 mb-0.5">
                  slaMinScore (0–1)
                </label>
                <input
                  id="discovery-sla-min"
                  type="number"
                  min={0}
                  max={1}
                  step="0.01"
                  value={form.discoverySlaMin}
                  onChange={(e) => setForm({ ...form, discoverySlaMin: e.target.value })}
                  placeholder="optional"
                  disabled={!canEdit}
                  className="w-full px-2 py-1.5 bg-zinc-800/50 border border-zinc-700 rounded text-xs text-zinc-100 disabled:opacity-50"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label htmlFor="discovery-gpu-ram-min" className="block text-[11px] text-zinc-500 mb-0.5">
                  GPU RAM min (GB)
                </label>
                <input
                  id="discovery-gpu-ram-min"
                  type="number"
                  min={0}
                  value={form.discoveryGpuRamGbMin}
                  onChange={(e) => setForm({ ...form, discoveryGpuRamGbMin: e.target.value })}
                  disabled={!canEdit}
                  className="w-full px-2 py-1.5 bg-zinc-800/50 border border-zinc-700 rounded text-xs text-zinc-100 disabled:opacity-50"
                />
              </div>
              <div>
                <label htmlFor="discovery-gpu-ram-max" className="block text-[11px] text-zinc-500 mb-0.5">
                  GPU RAM max (GB)
                </label>
                <input
                  id="discovery-gpu-ram-max"
                  type="number"
                  min={0}
                  value={form.discoveryGpuRamGbMax}
                  onChange={(e) => setForm({ ...form, discoveryGpuRamGbMax: e.target.value })}
                  disabled={!canEdit}
                  className="w-full px-2 py-1.5 bg-zinc-800/50 border border-zinc-700 rounded text-xs text-zinc-100 disabled:opacity-50"
                />
              </div>
              <div>
                <label htmlFor="discovery-price-max" className="block text-[11px] text-zinc-500 mb-0.5">
                  price max
                </label>
                <input
                  id="discovery-price-max"
                  type="number"
                  min={0}
                  step="0.0001"
                  value={form.discoveryPriceMax}
                  onChange={(e) => setForm({ ...form, discoveryPriceMax: e.target.value })}
                  disabled={!canEdit}
                  className="w-full px-2 py-1.5 bg-zinc-800/50 border border-zinc-700 rounded text-xs text-zinc-100 disabled:opacity-50"
                />
              </div>
              <div>
                <label htmlFor="discovery-max-avg-latency-ms" className="block text-[11px] text-zinc-500 mb-0.5">
                  max avg latency (ms)
                </label>
                <input
                  id="discovery-max-avg-latency-ms"
                  type="number"
                  min={0}
                  value={form.discoveryMaxAvgLatencyMs}
                  onChange={(e) => setForm({ ...form, discoveryMaxAvgLatencyMs: e.target.value })}
                  disabled={!canEdit}
                  className="w-full px-2 py-1.5 bg-zinc-800/50 border border-zinc-700 rounded text-xs text-zinc-100 disabled:opacity-50"
                />
              </div>
              <div className="col-span-2">
                <label htmlFor="discovery-max-swap-ratio" className="block text-[11px] text-zinc-500 mb-0.5">
                  max swap ratio (0–1)
                </label>
                <input
                  id="discovery-max-swap-ratio"
                  type="number"
                  min={0}
                  max={1}
                  step="0.01"
                  value={form.discoveryMaxSwapRatio}
                  onChange={(e) => setForm({ ...form, discoveryMaxSwapRatio: e.target.value })}
                  disabled={!canEdit}
                  className="w-full px-2 py-1.5 bg-zinc-800/50 border border-zinc-700 rounded text-xs text-zinc-100 disabled:opacity-50"
                />
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={createProfile}
            disabled={!canEdit || saving}
            className="w-full px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm hover:bg-emerald-500 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Create profile"}
          </button>
        </section>

        <section className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-6">
          <h2 className="text-lg font-semibold text-zinc-100 mb-4">Existing profiles</h2>
          {loading ? (
            <div className="text-zinc-500 animate-pulse">Loading…</div>
          ) : profiles.length === 0 ? (
            <div className="text-zinc-500">No discovery profiles yet.</div>
          ) : (
            <div className="space-y-4">
              {profiles.map((p) => (
                <div key={p.id} className="rounded-xl border border-zinc-800 bg-zinc-800/30 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <h3 className="text-sm font-semibold text-zinc-100">{p.name}</h3>
                      <p className="text-xs text-zinc-500 mt-1 font-mono break-all">{p.id}</p>
                      {formatDiscoveryPolicyShort(p.policy) && (
                        <p className="text-xs text-sky-400/90 mt-2">
                          Defaults: {formatDiscoveryPolicyShort(p.policy)}
                        </p>
                      )}
                      {p.capabilities.length > 0 && (
                        <div className="mt-2 space-y-1">
                          {p.capabilities.map((c) => (
                            <p key={`${c.pipeline}:${c.modelId}`} className="text-xs text-zinc-400">
                              <span className="text-zinc-200">{c.pipeline}</span>
                              {" · "}
                              {c.modelId === "*" ? (
                                <span className="text-emerald-400/80">all models</span>
                              ) : (
                                c.modelId
                              )}
                              {formatDiscoveryPolicyShort(c.discoveryPolicy) && (
                                <span className="text-zinc-500">
                                  {" "}
                                  — {formatDiscoveryPolicyShort(c.discoveryPolicy)}
                                </span>
                              )}
                            </p>
                          ))}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => deleteProfile(p.id)}
                      disabled={!canEdit}
                      className="text-xs text-zinc-500 hover:text-red-400 disabled:opacity-40 shrink-0"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </DashboardLayout>
  );
}
