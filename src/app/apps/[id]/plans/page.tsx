"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import DashboardLayout from "@/components/DashboardLayout";
import AppSectionBreadcrumb from "@/components/apps/AppSectionBreadcrumb";
import NetworkPricePlanSection from "@/components/apps/NetworkPricePlanSection";
import PipelineModelPicker from "@/components/PipelineModelPicker";

import type { PipelineCatalogEntry } from "@/components/PipelineModelPicker";
import {
  expandDocumentToConcreteKeys,
  normalizeDiscoveryAllowlistDoc,
} from "@/lib/discovery-allowlist";
import { planDisplayName } from "@/lib/network-default-plan-display";
import { PLAN_TEMPLATES } from "@/lib/plan-templates";

interface PlanRow {
  id: string;
  name: string;
  type: string;
  priceAmount: string;
  priceCurrency: string;
  status: string;
  includedUnits: string | null;
  overageRateWei: string | null;
  includedUsdMicros: string | null;
  generalUpchargePercentBps: number | null;
  payPerUseUpchargePercentBps: number | null;
  billingCycle: string;
  discoveryProfileId?: string | null;
  isNetworkDefault?: boolean;
  discoveryExcludedCapabilities?: { capabilities: unknown[] } | null;
  capabilities: {
    id: string;
    pipeline: string;
    modelId: string;
    slaTargetP95Ms: number | null;
    maxPricePerUnit: string | null;
    upchargePercentBps: number | null;
  }[];
}

const USD_MICROS = 1_000_000;

function usdMicrosToDisplay(micros: string | null | undefined): string {
  if (!micros) return "";
  const n = parseInt(micros, 10);
  if (isNaN(n)) return "";
  return (n / USD_MICROS).toFixed(2);
}

function displayToUsdMicros(display: string): string | null {
  const n = parseFloat(display);
  if (!isFinite(n) || n < 0) return null;
  return Math.round(n * USD_MICROS).toString();
}

function bpsToPercent(bps: number | null | undefined): string {
  if (bps == null) return "";
  return (bps / 100).toFixed(2);
}

const PLAN_TYPES = [
  { value: "free", label: "Free" },
  { value: "subscription", label: "Subscription" },
  { value: "usage", label: "Pay-Per-Use" },
] as const;

/** Avoid `response.json()` on empty / HTML error bodies (throws SyntaxError). */
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

export default function AppPlansPage() {
  const { id } = useParams<{ id: string }>();
  const [appName, setAppName] = useState("App");
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [catalog, setCatalog] = useState<PipelineCatalogEntry[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [canEdit, setCanEdit] = useState(true);
  const [planError, setPlanError] = useState<string | null>(null);
  const [form, setForm] = useState({
    templateId: "blank",
    name: "",
    type: "free",
    priceAmount: "0",
    priceCurrency: "USD",
    includedUnits: "",
    overageRateWei: "",
    includedUsdDisplay: "",
    generalUpchargePct: "",
    payPerUseUpchargePct: "",
    capabilityKeys: [] as string[],
    capabilityUpchargePct: "",
  });

  const catalogLite = useMemo(
    () => catalog.map((e) => ({ id: e.id, models: e.models })),
    [catalog],
  );

  const blockedConcreteKeys = useMemo(() => {
    const net = plans.find((p) => p.isNetworkDefault);
    const doc = normalizeDiscoveryAllowlistDoc(net?.discoveryExcludedCapabilities ?? null);
    if (!doc || !catalogLite.length) return new Set<string>();
    return expandDocumentToConcreteKeys(doc, catalogLite);
  }, [plans, catalogLite]);

  const sortedPlans = useMemo(
    () =>
      [...plans].sort(
        (a, b) =>
          (b.isNetworkDefault === true ? 1 : 0) - (a.isNetworkDefault === true ? 1 : 0),
      ),
    [plans],
  );

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      fetch(`/api/v1/apps/${id}`).then(readFetchJson),
      fetch(`/api/v1/apps/${id}/plans`).then(readFetchJson),
    ])
      .then(([appWrap, plansWrap]) => {
        const app = appWrap.body;
        setAppName((typeof app.name === "string" ? app.name : "") || "App");
        setCanEdit(app.canEdit !== false);
        if (plansWrap.ok && Array.isArray(plansWrap.body.plans)) {
          setPlans(plansWrap.body.plans as PlanRow[]);
          setPlanError(null);
        } else {
          setPlans([]);
          const msg =
            typeof plansWrap.body.error === "string"
              ? plansWrap.body.error
              : `Could not load plans (HTTP ${plansWrap.status})`;
          setPlanError(msg);
        }
      })
      .catch((err) => {
        setPlans([]);
        setPlanError(err instanceof Error ? err.message : "Failed to load plans");
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
          setCatalog(cat as PipelineCatalogEntry[]);
          setCatalogError(null);
        } else if (typeof body.error === "string") {
          setCatalogError(body.error);
        } else if (!ok) {
          setCatalogError(`Pipeline catalog unavailable (HTTP ${status})`);
        }
      })
      .catch(() => setCatalogError("NaaP catalog unavailable"));
  }, []);

  const applyTemplate = (templateId: string) => {
    const t = PLAN_TEMPLATES.find((x) => x.id === templateId);
    if (!t) return;
    setForm((prev) => ({
      ...prev,
      templateId,
      type: t.type,
      generalUpchargePct: t.generalUpchargePercentBps != null ? String(t.generalUpchargePercentBps / 100) : "",
      payPerUseUpchargePct: t.payPerUseUpchargePercentBps != null ? String(t.payPerUseUpchargePercentBps / 100) : "",
      capabilityKeys: [...t.capabilityKeys],
      capabilityUpchargePct:
        t.capabilityUpchargePercentBps != null ? String(t.capabilityUpchargePercentBps / 100) : "",
    }));
  };

  const parseBps = (pct: string): number | null => {
    const n = parseFloat(pct);
    if (!isFinite(n) || n < 0) return null;
    return Math.round(n * 100);
  };

  const createPlan = async () => {
    if (!canEdit || !form.name.trim()) return;
    setSaving(true);
    setPlanError(null);
    try {
      const generalBps = form.generalUpchargePct ? parseBps(form.generalUpchargePct) : null;
      const payPerUseBps = form.payPerUseUpchargePct ? parseBps(form.payPerUseUpchargePct) : null;
      const capabilityBps = form.capabilityUpchargePct ? parseBps(form.capabilityUpchargePct) : null;
      const includedUsdMicros =
        form.type === "subscription" && form.includedUsdDisplay
          ? displayToUsdMicros(form.includedUsdDisplay)
          : null;

      const capabilities = form.capabilityKeys.map((key) => {
        const sep = key.indexOf("|");
        const isWildcard = sep === -1;
        return {
          pipeline: isWildcard ? key : key.slice(0, sep),
          modelId: isWildcard ? "*" : key.slice(sep + 1),
          upchargePercentBps: capabilityBps,
        };
      });

      const res = await fetch(`/api/v1/apps/${id}/plans`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          type: form.type,
          priceAmount: form.priceAmount,
          priceCurrency: form.priceCurrency,
          status: "active",
          includedUnits:
            form.type === "subscription" && form.includedUnits.trim()
              ? form.includedUnits.trim()
              : null,
          overageRateWei:
            (form.type === "subscription" || form.type === "usage") && form.overageRateWei.trim()
              ? form.overageRateWei.trim()
              : null,
          includedUsdMicros,
          generalUpchargePercentBps: generalBps,
          payPerUseUpchargePercentBps: payPerUseBps,
          capabilities,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setPlanError(data?.error ?? `Failed to create plan (${res.status})`);
        return;
      }
      setForm({
        templateId: "blank",
        name: "",
        type: "free",
        priceAmount: "0",
        priceCurrency: "USD",
        includedUnits: "",
        overageRateWei: "",
        includedUsdDisplay: "",
        generalUpchargePct: "",
        payPerUseUpchargePct: "",
        capabilityKeys: [],
        capabilityUpchargePct: "",
      });
      load();
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : "Failed to create plan");
    } finally {
      setSaving(false);
    }
  };

  const deletePlan = async (planId: string) => {
    if (!canEdit) return;
    try {
      const res = await fetch(`/api/v1/apps/${id}/plans?planId=${encodeURIComponent(planId)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setPlanError(data?.error ?? `Failed to delete plan (${res.status})`);
        return;
      }
      load();
    } catch (err) {
      setPlanError(`Network error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <DashboardLayout>
      <div className="mb-8">
        <AppSectionBreadcrumb appId={id} appName={appName} />
        <h1 className="text-2xl font-bold text-zinc-100">Plans &amp; network discovery</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Network Price defines what integrators can discover. Custom plans add pricing overrides for
          a subset of discoverable pipelines and models only.
        </p>
        {!canEdit && (
          <p className="text-sm text-amber-400/90 mt-2">
            View only — only platform or app administrators can create or delete plans.
          </p>
        )}
        {planError && (
          <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 mt-2">
            {planError}
          </p>
        )}
      </div>

      <NetworkPricePlanSection appId={id} canEdit={canEdit} />

      <div className="grid gap-6 lg:grid-cols-[400px_1fr]">
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-6 space-y-4">
          <h2 className="text-lg font-semibold text-zinc-100">New custom plan</h2>

          <div>
            <label className="block text-xs text-zinc-500 mb-1">Template</label>
            <select
              value={form.templateId}
              disabled={!canEdit}
              onChange={(e) => {
                const v = e.target.value;
                setForm((prev) => ({ ...prev, templateId: v }));
                applyTemplate(v);
              }}
              className="w-full px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-sm text-zinc-100 disabled:opacity-50"
            >
              {PLAN_TEMPLATES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-zinc-600 mt-1">
              {PLAN_TEMPLATES.find((t) => t.id === form.templateId)?.description}
            </p>
          </div>

          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Plan name"
            disabled={!canEdit}
            className="w-full px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-sm text-zinc-100 disabled:opacity-50"
          />
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Type</label>
            <div
              className="flex w-full overflow-hidden rounded-lg border border-zinc-700"
              role="group"
              aria-label="Plan type"
            >
              {PLAN_TYPES.map((t, i) => (
                <button
                  key={t.value}
                  type="button"
                  disabled={!canEdit}
                  onClick={() => setForm({ ...form, type: t.value })}
                  className={`flex-1 min-w-0 px-2 py-2 text-xs sm:text-sm font-medium transition-colors disabled:opacity-50 ${
                    form.type === t.value
                      ? "bg-emerald-600 text-white"
                      : "bg-zinc-800/50 text-zinc-400 hover:text-zinc-200"
                  } ${i > 0 ? "border-l border-zinc-700" : ""}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Monthly price (USD)</label>
            <input
              value={form.priceAmount}
              onChange={(e) => setForm({ ...form, priceAmount: e.target.value })}
              placeholder="0"
              disabled={!canEdit}
              className="w-full px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-sm text-zinc-100 disabled:opacity-50"
            />
          </div>

          {form.type === "subscription" && (
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Included usage allowance (USD)</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.includedUsdDisplay}
                onChange={(e) => setForm({ ...form, includedUsdDisplay: e.target.value })}
                placeholder="e.g. 10.00"
                disabled={!canEdit}
                className="w-full px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-sm text-zinc-100 disabled:opacity-50"
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-zinc-500 mb-1">General upcharge (%)</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.generalUpchargePct}
                onChange={(e) => setForm({ ...form, generalUpchargePct: e.target.value })}
                placeholder="e.g. 20"
                disabled={!canEdit}
                className="w-full px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-sm text-zinc-100 disabled:opacity-50"
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Pay-per-use upcharge (%)</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.payPerUseUpchargePct}
                onChange={(e) => setForm({ ...form, payPerUseUpchargePct: e.target.value })}
                placeholder="optional"
                disabled={!canEdit}
                className="w-full px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-sm text-zinc-100 disabled:opacity-50"
              />
            </div>
          </div>

          <div className="border-t border-zinc-800 pt-4 space-y-3">
            <h3 className="text-sm font-medium text-zinc-300">Pipeline / model capabilities</h3>
            {catalogError && (
              <p className="text-xs text-amber-400">{catalogError} — existing bundles still work.</p>
            )}
            {catalog.length > 0 ? (
              <div>
                <label className="block text-xs text-zinc-500 mb-1">
                  Pipelines &amp; models (must stay within Network Price discovery)
                </label>
                <PipelineModelPicker
                  catalog={catalog}
                  values={form.capabilityKeys}
                  onChange={(keys) => setForm({ ...form, capabilityKeys: keys })}
                  disabled={!canEdit}
                  blockedConcreteKeys={blockedConcreteKeys}
                  blockedSelectionTitle="Excluded in Network Price — un-exclude there first."
                />
              </div>
            ) : (
              <p className="text-xs text-zinc-500 italic">
                No catalog available — pipeline capabilities cannot be configured.
              </p>
            )}
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Capability upcharge (%)</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.capabilityUpchargePct}
                onChange={(e) => setForm({ ...form, capabilityUpchargePct: e.target.value })}
                placeholder="optional"
                disabled={!canEdit || form.capabilityKeys.length === 0}
                className="w-full px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-sm text-zinc-100 disabled:opacity-50"
              />
            </div>
            {form.capabilityKeys.length > 0 && (
              <p className="text-xs text-zinc-500">
                {form.capabilityKeys.length}{" "}
                {form.capabilityKeys.length !== 1 ? "capabilities" : "capability"} will be added to
                this plan.
              </p>
            )}
          </div>

          <button
            type="button"
            onClick={() => void createPlan()}
            disabled={!canEdit || saving}
            className="w-full px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm hover:bg-emerald-500 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Create plan"}
          </button>
        </section>

        <section className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-6">
          <h2 className="text-lg font-semibold text-zinc-100 mb-4">Existing plans</h2>
          {loading ? (
            <div className="text-zinc-500 animate-pulse">Loading plans...</div>
          ) : sortedPlans.length === 0 ? (
            <div className="text-zinc-500">No plans yet.</div>
          ) : (
            <div className="space-y-4">
              {sortedPlans.map((plan) => (
                <div key={plan.id} className="rounded-xl border border-zinc-800 bg-zinc-800/30 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <h3 className="text-sm font-semibold text-zinc-100 flex flex-wrap items-center gap-2">
                        {planDisplayName({
                          name: plan.name,
                          isNetworkDefault: plan.isNetworkDefault === true,
                        })}
                        {plan.isNetworkDefault && (
                          <span className="text-[10px] font-medium uppercase tracking-wide text-emerald-400/90 border border-emerald-500/30 rounded px-1.5 py-0.5">
                            Default
                          </span>
                        )}
                      </h3>
                      <p className="text-xs text-zinc-500 mt-1">
                        {plan.type} · {plan.priceAmount} {plan.priceCurrency}
                        {plan.billingCycle ? ` · ${plan.billingCycle}` : ""}
                      </p>
                      {plan.includedUsdMicros && (
                        <p className="text-xs text-emerald-400/80 mt-1">
                          Includes ${usdMicrosToDisplay(plan.includedUsdMicros)} USD usage
                        </p>
                      )}
                      {(plan.generalUpchargePercentBps != null ||
                        plan.payPerUseUpchargePercentBps != null) && (
                        <p className="text-xs text-zinc-400 mt-1">
                          {plan.generalUpchargePercentBps != null &&
                            `General upcharge: ${bpsToPercent(plan.generalUpchargePercentBps)}%`}
                          {plan.generalUpchargePercentBps != null &&
                            plan.payPerUseUpchargePercentBps != null &&
                            " · "}
                          {plan.payPerUseUpchargePercentBps != null &&
                            `PPU upcharge: ${bpsToPercent(plan.payPerUseUpchargePercentBps)}%`}
                        </p>
                      )}
                      {plan.capabilities.length > 0 && (
                        <div className="mt-3 space-y-1">
                          {plan.capabilities.map((cap) => (
                            <p key={cap.id} className="text-xs text-zinc-400">
                              <span className="text-zinc-200">{cap.pipeline}</span>
                              {" · "}
                              {cap.modelId === "*" ? (
                                <span className="text-emerald-400/80">all models</span>
                              ) : (
                                cap.modelId
                              )}
                              {cap.upchargePercentBps != null &&
                                ` · ${bpsToPercent(cap.upchargePercentBps)}% upcharge`}
                            </p>
                          ))}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => void deletePlan(plan.id)}
                      disabled={!canEdit || plan.isNetworkDefault === true}
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
