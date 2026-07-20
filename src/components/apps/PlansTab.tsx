"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PipelineModelPicker from "@/components/PipelineModelPicker";

import type { PipelineCatalogEntry } from "@/components/PipelineModelPicker";
import {
  excludedDocumentFromPickerValues,
  expandDocumentToConcreteKeys,
  fullCatalogConcreteKeys,
  isDiscoveryDocumentEmpty,
  normalizeDiscoveryAllowlistDoc,
  pickerValuesFromExcludedDocument,
} from "@/lib/discovery-allowlist";
import { planDisplayName } from "@/lib/network-default-plan-display";
import { planDisplayNameWithStarter } from "@/lib/starter-default-plan-display";
import {
  markupPercentToRetailRateUsd,
  retailRateUsdPerMillion,
  retailRateUsdToMarkupPercent,
  parseMarkupPercentInput,
} from "@/lib/plan-pricing";
import { validateCapabilityFeatureKeys } from "@/lib/openmeter/capability-features";
import {
  CUSTOM_PLAN_NAME_MAX_LENGTH,
  validateCustomPlanName,
} from "@/lib/openmeter/plan-naming";
import {
  formatUsdMicrosDisplay,
  normalizeUsdCentsDisplay,
  sanitizeUsdCentsInput,
  usdCentsDisplayToMicros,
  usdMicrosToCentsDisplay,
} from "@/lib/format-usd-micros";

// ── Types & utilities ─────────────────────────────────────────────────────────

interface PlanRow {
  id: string;
  name: string;
  type: string;
  priceAmount: string;
  priceCurrency: string;
  status: string;
  overageRateUsd: string | null;
  includedUsdMicros: string | null;
  billingCycle: string;
  discoveryProfileId?: string | null;
  isNetworkDefault?: boolean;
  isStarterDefault?: boolean;
  discoveryExcludedCapabilities?: { capabilities: unknown[] } | null;
  openmeterPlanId?: string | null;
  openmeterPlanVersion?: number | null;
  lastSyncedAt?: string | null;
  syncError?: string | null;
  sync?: {
    status: "not_applicable" | "pending" | "synced" | "error";
    syncedAt: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    openmeterPlanId?: string | null;
  };
  capabilities: {
    id: string;
    pipeline: string;
    modelId: string;
    slaTargetP95Ms: number | null;
    maxPricePerUnit: string | null;
    retailRateUsd: string | null;
    markupPercent?: string | null;
    effectiveRetailRateUsd?: string;
    featureKey?: string;
  }[];
}

/** Shown only when OpenMeter sync failed (e.g. after save); omit success timestamps. */
function planSyncFailureMessage(plan: PlanRow): string | null {
  if (plan.isNetworkDefault || plan.type === "free") {
    return null;
  }
  const detail = (plan.sync?.errorMessage || plan.syncError)?.trim();
  if (plan.sync?.status === "error" || detail) {
    return detail ? `OpenMeter sync failed: ${detail}` : "OpenMeter sync failed";
  }
  return null;
}

type CatalogLite = { id: string; models: string[] };

interface PlanDraft {
  name: string;
  type: string;
  priceAmount: string;
  priceCurrency: string;
  includedUsdDisplay: string;
  defaultMarkupPct: string;
  capabilityKeys: string[];
  capabilityMarkupByKey: Record<string, string>;
}

const PLAN_TYPES = [
  { value: "free", label: "Free" },
  { value: "subscription", label: "Subscription" },
  { value: "usage", label: "Pay-Per-Use" },
] as const;

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

function usdMicrosToDisplay(micros: string | null | undefined): string {
  if (!micros) return "";
  return usdMicrosToCentsDisplay(micros);
}

function displayToUsdMicros(display: string): string | null {
  return usdCentsDisplayToMicros(display);
}

function DollarCentsInput({
  id,
  value,
  onChange,
  disabled,
  placeholder = "5.00",
  "aria-label": ariaLabel,
}: Readonly<{
  id?: string;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  placeholder?: string;
  "aria-label"?: string;
}>) {
  return (
    <div
      className={`flex items-center rounded-lg border border-zinc-700 bg-zinc-800/50 focus-within:border-sky-500/40 focus-within:ring-1 focus-within:ring-sky-500/20 ${
        disabled ? "opacity-50" : ""
      }`}
    >
      <span className="pl-3 text-sm text-zinc-500 select-none" aria-hidden="true">
        $
      </span>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(sanitizeUsdCentsInput(e.target.value))}
        onBlur={() => {
          if (value.trim() === "") return;
          onChange(normalizeUsdCentsDisplay(value));
        }}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={ariaLabel}
        className="w-full bg-transparent px-2 py-2 text-sm tabular-nums text-zinc-100 placeholder:text-zinc-600 focus:outline-hidden disabled:cursor-not-allowed"
      />
    </div>
  );
}

function catalogLiteFrom(catalog: PipelineCatalogEntry[]): CatalogLite[] {
  return catalog.map((e) => ({ id: e.id, models: e.models }));
}

function allCatalogPickerValues(catalog: PipelineCatalogEntry[]): string[] {
  return catalog.map((e) => e.id);
}

function discoverablePickerValuesForCatalog(
  catalog: PipelineCatalogEntry[],
  blockedConcreteKeys: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const e of catalog) {
    const blockedModels = e.models.filter((m) =>
      blockedConcreteKeys.has(`${e.id}|${m}`),
    );
    if (blockedModels.length === e.models.length) continue;
    if (blockedModels.length === 0) {
      out.push(e.id);
      continue;
    }
    for (const m of e.models) {
      if (!blockedConcreteKeys.has(`${e.id}|${m}`)) {
        out.push(`${e.id}|${m}`);
      }
    }
  }
  return out;
}

function planCapabilitiesToPickerKeys(
  capabilities: PlanRow["capabilities"],
): string[] {
  const keys: string[] = [];
  const byPipeline = new Map<string, Set<string>>();
  for (const cap of capabilities) {
    if (cap.modelId === "*") {
      keys.push(cap.pipeline);
      continue;
    }
    let set = byPipeline.get(cap.pipeline);
    if (!set) {
      set = new Set();
      byPipeline.set(cap.pipeline, set);
    }
    set.add(cap.modelId);
  }
  for (const [pipeline, models] of byPipeline) {
    for (const m of models) {
      keys.push(`${pipeline}|${m}`);
    }
  }
  return keys;
}

function capabilityKeyLabel(key: string, catalog: PipelineCatalogEntry[]): string {
  if (!key.includes("|")) {
    const entry = catalog.find((e) => e.id === key);
    return `${entry?.name ?? key} · all models`;
  }
  const sep = key.indexOf("|");
  return capabilityChipLabel(key.slice(0, sep), key.slice(sep + 1), catalog);
}

function syncCapabilityMarkups(
  prev: Record<string, string>,
  keys: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    out[k] = prev[k] ?? "";
  }
  return out;
}

function capabilitiesToMarkupByKey(
  capabilities: PlanRow["capabilities"],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const cap of capabilities) {
    const key = cap.modelId === "*" ? cap.pipeline : `${cap.pipeline}|${cap.modelId}`;
    out[key] = retailRateUsdToMarkupPercent(cap.retailRateUsd);
  }
  return out;
}

function pickerKeysToCapabilities(
  keys: string[],
  markupByKey: Record<string, string>,
): Array<{ pipeline: string; modelId: string; retailRateUsd: string | null }> {
  return keys.map((key) => {
    const sep = key.indexOf("|");
    const isWildcard = sep === -1;
    const markupRaw = markupByKey[key]?.trim() ?? "";
    const markup = parseMarkupPercentInput(markupRaw);
    return {
      pipeline: isWildcard ? key : key.slice(0, sep),
      modelId: isWildcard ? "*" : key.slice(sep + 1),
      retailRateUsd:
        markup != null && markup > 0 ? markupPercentToRetailRateUsd(markup) : null,
    };
  });
}

function planToDraft(plan: PlanRow): PlanDraft {
  const caps = plan.capabilities;
  const capabilityKeys = planCapabilitiesToPickerKeys(caps);
  return {
    name: plan.name,
    type: plan.type,
    priceAmount: plan.priceAmount,
    priceCurrency: plan.priceCurrency,
    includedUsdDisplay: usdMicrosToDisplay(plan.includedUsdMicros),
    defaultMarkupPct: retailRateUsdToMarkupPercent(plan.overageRateUsd),
    capabilityKeys,
    capabilityMarkupByKey: capabilitiesToMarkupByKey(caps),
  };
}

function emptyDraft(): PlanDraft {
  return {
    name: "",
    type: "free",
    priceAmount: "0",
    priceCurrency: "USD",
    includedUsdDisplay: "",
    defaultMarkupPct: "",
    capabilityKeys: [],
    capabilityMarkupByKey: {},
  };
}

function capabilityChipLabel(
  pipeline: string,
  modelId: string,
  catalog: PipelineCatalogEntry[],
): string {
  const entry = catalog.find((e) => e.id === pipeline);
  const name = entry?.name ?? pipeline;
  if (modelId === "*") return `${name} · all models`;
  return `${name} · ${modelId}`;
}

function sortedCapabilityKeys(keys: string[], catalog: PipelineCatalogEntry[]): string[] {
  return [...keys].sort((a, b) => {
    const la = capabilityKeyLabel(a, catalog);
    const lb = capabilityKeyLabel(b, catalog);
    return la.localeCompare(lb);
  });
}

// ── Shared UI ─────────────────────────────────────────────────────────────────

function PlanTypePills({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div
      className="flex w-full overflow-hidden rounded-lg border border-zinc-700"
      role="group"
      aria-label="Plan type"
    >
      {PLAN_TYPES.map((t, i) => (
        <button
          key={t.value}
          type="button"
          disabled={disabled}
          onClick={() => onChange(t.value)}
          className={`flex-1 min-w-0 px-2 py-2 text-xs sm:text-sm font-medium transition-colors disabled:opacity-50 ${
            value === t.value
              ? "bg-emerald-600 text-white"
              : "bg-zinc-800/50 text-zinc-400 hover:text-zinc-200"
          } ${i > 0 ? "border-l border-zinc-700" : ""}`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function CapabilityChips({
  capabilities,
  catalog,
}: {
  capabilities: PlanRow["capabilities"];
  catalog: PipelineCatalogEntry[];
}) {
  if (capabilities.length === 0) {
    return <span className="text-xs text-zinc-500">No pipeline overrides</span>;
  }
  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {capabilities.map((cap) => (
        <span
          key={cap.id}
          className="inline-flex max-w-full rounded-full bg-zinc-700/80 px-2 py-0.5 text-xs text-zinc-200 truncate"
        >
          {capabilityChipLabel(cap.pipeline, cap.modelId, catalog)}
          {cap.retailRateUsd != null && (
            <span className="text-zinc-400 ml-1">
              ${retailRateUsdPerMillion(cap.retailRateUsd)}/M
            </span>
          )}
        </span>
      ))}
    </div>
  );
}

const SUGGESTED_MARKUP_RATES = [0, 5, 10, 15, 20, 25, 30, 50] as const;

function sanitizePlanNameInput(raw: string): string {
  return raw.replace(/[^A-Za-z0-9 _.-]/g, "");
}

function resolvePlanOverageRateUsd(
  planType: string,
  defaultMarkupPct: string,
): string | null {
  if (planType === "free") {
    return null;
  }
  const defaultMarkup = parseMarkupPercentInput(defaultMarkupPct.trim());
  if (defaultMarkup == null || defaultMarkup <= 0) {
    return null;
  }
  return markupPercentToRetailRateUsd(defaultMarkup);
}

function sanitizePercentInput(raw: string): string {
  let s = raw.replace(/[^\d.]/g, "");
  const dot = s.indexOf(".");
  if (dot !== -1) {
    s = `${s.slice(0, dot + 1)}${s.slice(dot + 1).replace(/\./g, "")}`;
  }
  return s;
}

function CapabilityPricingRow({
  capKey,
  label,
  markupPct,
  canEdit,
  idPrefix,
  onMarkupChange,
  onRemove,
}: {
  capKey: string;
  label: string;
  markupPct: string;
  canEdit: boolean;
  idPrefix: string;
  onMarkupChange: (pct: string) => void;
  onRemove: () => void;
}) {
  const [markupFocused, setMarkupFocused] = useState(false);
  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearBlurTimeout = () => {
    if (blurTimeoutRef.current) {
      clearTimeout(blurTimeoutRef.current);
      blurTimeoutRef.current = null;
    }
  };

  const handleMarkupBlur = () => {
    clearBlurTimeout();
    blurTimeoutRef.current = setTimeout(() => setMarkupFocused(false), 120);
  };

  useEffect(() => () => clearBlurTimeout(), []);

  const currentRate = markupPct.trim() === "" ? null : parseFloat(markupPct);

  return (
    <div className="px-3 py-2.5">
      <div className="flex flex-wrap items-start gap-2 sm:gap-3">
        <span className="inline-flex items-center gap-1 min-w-0 max-w-full rounded-full bg-zinc-700/90 px-2.5 py-1 text-xs text-zinc-100">
          <span className="truncate">{label}</span>
          {canEdit && (
            <button
              type="button"
              onClick={onRemove}
              className="shrink-0 rounded p-0.5 text-zinc-400 hover:bg-zinc-600 hover:text-zinc-100"
              aria-label={`Remove ${label}`}
            >
              ×
            </button>
          )}
        </span>

        <div className="ml-auto flex flex-col items-end gap-1.5 min-w-[11rem]">
          <label
            className={`flex items-center gap-1.5 rounded-lg border px-2 py-1 transition-colors ${
              markupFocused
                ? "border-emerald-500/50 bg-zinc-800/80 ring-1 ring-emerald-500/20"
                : "border-zinc-700/80 bg-zinc-800/40"
            }`}
          >
            <span className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">
              Markup
            </span>
            <input
              id={`${idPrefix}-rule-${capKey.replace(/[|]/g, "-")}`}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={markupPct}
              onChange={(e) => onMarkupChange(sanitizePercentInput(e.target.value))}
              onFocus={() => {
                clearBlurTimeout();
                setMarkupFocused(true);
              }}
              onBlur={handleMarkupBlur}
              placeholder="—"
              disabled={!canEdit}
              aria-label={`Markup percent for ${label}`}
              className="w-12 bg-transparent text-right text-sm tabular-nums text-zinc-100 placeholder:text-zinc-600 disabled:opacity-50 focus:outline-none"
            />
            <span className="text-xs text-zinc-500">%</span>
          </label>

          {canEdit && markupFocused && (
            <div
              className="flex flex-wrap justify-end gap-1"
              role="group"
              aria-label="Suggested markup rates"
            >
              {SUGGESTED_MARKUP_RATES.map((rate) => {
                const active =
                  currentRate != null &&
                  !Number.isNaN(currentRate) &&
                  currentRate === rate;
                return (
                  <button
                    key={rate}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onMarkupChange(String(rate))}
                    className={`min-w-[2.25rem] rounded-md px-2 py-0.5 text-[11px] font-medium tabular-nums transition-colors ${
                      active
                        ? "bg-emerald-600 text-white"
                        : "border border-zinc-600/80 bg-zinc-800/60 text-zinc-300 hover:border-emerald-500/40 hover:bg-zinc-700 hover:text-zinc-100"
                    }`}
                  >
                    {rate}%
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CapabilityPricingRules({
  keys,
  markupByKey,
  catalog,
  canEdit,
  idPrefix,
  onMarkupChange,
  onRemove,
}: {
  keys: string[];
  markupByKey: Record<string, string>;
  catalog: PipelineCatalogEntry[];
  canEdit: boolean;
  idPrefix: string;
  onMarkupChange: (key: string, pct: string) => void;
  onRemove: (key: string) => void;
}) {
  const sorted = sortedCapabilityKeys(keys, catalog);

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 divide-y divide-zinc-800">
      {sorted.length === 0 ? (
        <p className="px-3 py-3 text-xs text-zinc-500">
          No capabilities yet — use the search above to add pipelines and models.
        </p>
      ) : (
        sorted.map((key) => (
          <CapabilityPricingRow
            key={key}
            capKey={key}
            label={capabilityKeyLabel(key, catalog)}
            markupPct={markupByKey[key] ?? ""}
            canEdit={canEdit}
            idPrefix={idPrefix}
            onMarkupChange={(pct) => onMarkupChange(key, pct)}
            onRemove={() => onRemove(key)}
          />
        ))
      )}
    </div>
  );
}

function TypeBadge({ type }: { type: string }) {
  const styles: Record<string, string> = {
    free: "text-emerald-400/90 border-emerald-500/30 bg-emerald-500/10",
    subscription: "text-sky-400/90 border-sky-500/30 bg-sky-500/10",
    usage: "text-violet-400/90 border-violet-500/30 bg-violet-500/10",
  };
  const label = PLAN_TYPES.find((t) => t.value === type)?.label ?? type;
  return (
    <span
      className={`text-[10px] font-medium uppercase tracking-wide border rounded px-1.5 py-0.5 shrink-0 ${
        styles[type] ?? "text-zinc-400 border-zinc-600"
      }`}
    >
      {label}
    </span>
  );
}

// ── Plan draft form (edit + create) ───────────────────────────────────────────

function PlanDraftForm({
  draft,
  onChange,
  catalog,
  catalogError,
  blockedConcreteKeys,
  canEdit,
  idPrefix,
}: {
  draft: PlanDraft;
  onChange: (d: PlanDraft) => void;
  catalog: PipelineCatalogEntry[];
  catalogError: string | null;
  blockedConcreteKeys: Set<string>;
  canEdit: boolean;
  idPrefix: string;
}) {
  return (
    <div className="space-y-4 pt-4 border-t border-zinc-800">
      <div>
        <label htmlFor={`${idPrefix}-name`} className="block text-xs text-zinc-500 mb-1">
          Plan name
        </label>
        <input
          id={`${idPrefix}-name`}
          value={draft.name}
          onChange={(e) =>
            onChange({
              ...draft,
              name: sanitizePlanNameInput(e.target.value).slice(0, CUSTOM_PLAN_NAME_MAX_LENGTH),
            })
          }
          placeholder="e.g. PPU lv2v"
          maxLength={CUSTOM_PLAN_NAME_MAX_LENGTH}
          disabled={!canEdit}
          className="w-full px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-sm text-zinc-100 disabled:opacity-50"
        />
        <p className="text-xs text-zinc-500 mt-1">
          Letters, numbers, spaces, hyphens, underscores, and periods only (max{" "}
          {CUSTOM_PLAN_NAME_MAX_LENGTH} chars). Required for OpenMeter sync.
        </p>
      </div>

      <div>
        <div className="block text-xs text-zinc-500 mb-1">Type</div>
        <PlanTypePills
          value={draft.type}
          onChange={(type) =>
            onChange({
              ...draft,
              type,
              priceAmount: type === "subscription" ? draft.priceAmount : "0",
            })
          }
          disabled={!canEdit}
        />
      </div>

      {(draft.type === "subscription" || draft.type === "usage") && (
        <div>
          <label htmlFor={`${idPrefix}-default-markup`} className="block text-xs text-zinc-500 mb-1">
            Default usage markup (% over network cost)
          </label>
          <input
            id={`${idPrefix}-default-markup`}
            type="text"
            inputMode="decimal"
            value={draft.defaultMarkupPct}
            onChange={(e) =>
              onChange({ ...draft, defaultMarkupPct: sanitizePercentInput(e.target.value) })
            }
            placeholder="0 = pass-through network pricing"
            disabled={!canEdit}
            className="w-full px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-sm text-zinc-100 disabled:opacity-50"
          />
        </div>
      )}

      {draft.type === "subscription" && (
        <>
          <div>
            <label htmlFor={`${idPrefix}-price`} className="block text-xs text-zinc-500 mb-1">
              Monthly price ({draft.priceCurrency})
            </label>
            <input
              id={`${idPrefix}-price`}
              value={draft.priceAmount}
              onChange={(e) => onChange({ ...draft, priceAmount: e.target.value })}
              disabled={!canEdit}
              className="w-full px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-sm text-zinc-100 disabled:opacity-50"
            />
          </div>
          <div>
          <label htmlFor={`${idPrefix}-included`} className="block text-xs text-zinc-500 mb-1">
            Included usage allowance
          </label>
          <DollarCentsInput
            id={`${idPrefix}-included`}
            value={draft.includedUsdDisplay}
            onChange={(includedUsdDisplay) => onChange({ ...draft, includedUsdDisplay })}
            placeholder="10.00"
            disabled={!canEdit}
            aria-label="Included usage allowance in dollars"
          />
          </div>
        </>
      )}

      <div className="space-y-2">
        <h4 className="text-sm font-medium text-zinc-300">Pipeline / model pricing</h4>
        {catalogError && (
          <p className="text-xs text-amber-400">{catalogError}</p>
        )}
        {catalog.length > 0 ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-zinc-500">Must stay within Network Price discovery</span>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={!canEdit}
                  onClick={() => {
                    const keys = discoverablePickerValuesForCatalog(
                      catalog,
                      blockedConcreteKeys,
                    );
                    onChange({
                      ...draft,
                      capabilityKeys: keys,
                      capabilityMarkupByKey: syncCapabilityMarkups(
                        draft.capabilityMarkupByKey,
                        keys,
                      ),
                    });
                  }}
                  className="text-xs px-2.5 py-1 rounded-md border border-zinc-600 text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                >
                  Select all
                </button>
                <button
                  type="button"
                  disabled={!canEdit}
                  onClick={() =>
                    onChange({
                      ...draft,
                      capabilityKeys: [],
                      capabilityMarkupByKey: {},
                    })
                  }
                  className="text-xs px-2.5 py-1 rounded-md border border-zinc-600 text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                >
                  Clear all
                </button>
              </div>
            </div>
            <PipelineModelPicker
              catalog={catalog}
              values={draft.capabilityKeys}
              onChange={(keys) =>
                onChange({
                  ...draft,
                  capabilityKeys: keys,
                  capabilityMarkupByKey: syncCapabilityMarkups(
                    draft.capabilityMarkupByKey,
                    keys,
                  ),
                })
              }
              disabled={!canEdit}
              showSelectedChips={false}
              blockedConcreteKeys={blockedConcreteKeys}
              blockedSelectionTitle="Excluded in Network Price — un-exclude there first."
            />
            <CapabilityPricingRules
              keys={draft.capabilityKeys}
              markupByKey={draft.capabilityMarkupByKey}
              catalog={catalog}
              canEdit={canEdit}
              idPrefix={idPrefix}
              onMarkupChange={(key, pct) =>
                onChange({
                  ...draft,
                  capabilityMarkupByKey: {
                    ...draft.capabilityMarkupByKey,
                    [key]: pct,
                  },
                })
              }
              onRemove={(key) => {
                const keys = draft.capabilityKeys.filter((k) => k !== key);
                onChange({
                  ...draft,
                  capabilityKeys: keys,
                  capabilityMarkupByKey: syncCapabilityMarkups(
                    draft.capabilityMarkupByKey,
                    keys,
                  ),
                });
              }}
            />
            <p className="text-xs text-zinc-600">
              Leave markup blank to bill at network cost. Markup applies as retail $/micro on OpenMeter rate cards.
            </p>
          </>
        ) : (
          <p className="text-xs text-zinc-500 italic">Catalog unavailable.</p>
        )}
      </div>
    </div>
  );
}

function buildPlanPayload(
  draft: PlanDraft,
  planId: string | undefined,
  _existing: PlanRow | null,
): Record<string, unknown> {
  const includedUsdMicros =
    draft.type === "subscription" && draft.includedUsdDisplay
      ? displayToUsdMicros(draft.includedUsdDisplay)
      : null;

  const capabilities = pickerKeysToCapabilities(
    draft.capabilityKeys,
    draft.capabilityMarkupByKey,
  );

  const overageRateUsd = resolvePlanOverageRateUsd(draft.type, draft.defaultMarkupPct);

  const payload: Record<string, unknown> = {
    name: draft.name.trim(),
    type: draft.type,
    priceAmount: draft.priceAmount,
    priceCurrency: draft.priceCurrency,
    ...(planId ? {} : { status: "active" }),
    capabilities,
    includedUsdMicros,
    overageRateUsd,
  };

  if (planId) payload.id = planId;

  return payload;
}

function openMeterCapabilityValidationError(
  appId: string,
  planId: string,
  draft: PlanDraft,
): string | null {
  if (draft.type === "free") {
    return null;
  }
  const capabilities = pickerKeysToCapabilities(
    draft.capabilityKeys,
    draft.capabilityMarkupByKey,
  );
  if (capabilities.length === 0) {
    return null;
  }
  const result = validateCapabilityFeatureKeys({
    clientId: appId,
    planId,
    capabilities,
  });
  return result.ok ? null : result.error;
}

// ── Collapsed card hit area ───────────────────────────────────────────────────

function CollapsedPlanCardHitArea({
  enabled,
  ariaLabel,
  onActivate,
}: {
  enabled: boolean;
  ariaLabel: string;
  onActivate: () => void;
}) {
  if (!enabled) return null;
  return (
    <button
      type="button"
      onClick={onActivate}
      className="absolute inset-0 z-0 cursor-pointer rounded-xl outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-500/60"
      aria-label={ariaLabel}
    />
  );
}

// ── Network Price card ────────────────────────────────────────────────────────

function NetworkPricePlanCard({
  appId,
  plan,
  catalog,
  catalogError,
  canEdit,
  onSaved,
}: {
  appId: string;
  plan: PlanRow;
  catalog: PipelineCatalogEntry[];
  catalogError: string | null;
  canEdit: boolean;
  onSaved: () => void | Promise<void>;
}) {
  const catalogLite = useMemo(() => catalogLiteFrom(catalog), [catalog]);
  const [expanded, setExpanded] = useState(false);
  const [pickerValues, setPickerValues] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [synced, setSynced] = useState(false);

  const excludedDoc = useMemo(
    () => normalizeDiscoveryAllowlistDoc(plan.discoveryExcludedCapabilities ?? null),
    [plan.discoveryExcludedCapabilities],
  );

  const pickerReady = expanded && catalogLite.length > 0 && synced;

  const excludesEntireCatalog = useMemo(() => {
    if (!pickerReady) return false;
    const doc = excludedDocumentFromPickerValues(catalogLite, pickerValues);
    const normalized = normalizeDiscoveryAllowlistDoc({ capabilities: doc });
    if (isDiscoveryDocumentEmpty(normalized)) return false;
    const ex = expandDocumentToConcreteKeys(normalized!, catalogLite);
    return ex.size === fullCatalogConcreteKeys(catalogLite).size;
  }, [pickerReady, catalogLite, pickerValues]);

  const discoverySummary = useMemo(() => {
    if (!catalogLite.length) {
      return "Pipeline catalog loading…";
    }
    if (isDiscoveryDocumentEmpty(excludedDoc)) {
      const n = catalogLite.length;
      return `All ${n} catalog pipeline${n === 1 ? "" : "s"} discoverable; new network capabilities are allowed by default`;
    }
    const excluded = expandDocumentToConcreteKeys(excludedDoc!, catalogLite);
    const labels: string[] = [];
    for (const e of catalog) {
      const exModels = e.models.filter((m) => excluded.has(`${e.id}|${m}`));
      if (exModels.length === e.models.length) {
        labels.push(e.name);
      } else {
        for (const m of exModels) {
          labels.push(`${e.name} · ${m}`);
        }
      }
    }
    const count = excluded.size;
    const preview = labels.slice(0, 4).join(", ");
    const more = labels.length > 4 ? ` +${labels.length - 4} more` : "";
    return `${count} exclusion${count === 1 ? "" : "s"} — ${preview}${more}`;
  }, [catalog, catalogLite, excludedDoc]);

  useEffect(() => {
    if (!expanded || !catalogLite.length) return;
    setPickerValues(pickerValuesFromExcludedDocument(catalogLite, excludedDoc));
    setSynced(true);
  }, [expanded, catalogLite, excludedDoc]);

  const openEdit = () => {
    setError(null);
    setSynced(false);
    setExpanded(true);
  };

  const discard = () => {
    setExpanded(false);
    setSynced(false);
    setError(null);
  };

  const saveDiscovery = async () => {
    if (!canEdit) return;
    setSaving(true);
    setError(null);
    try {
      const excludedCapabilities = excludedDocumentFromPickerValues(
        catalogLite,
        pickerValues,
      );
      const res = await fetch(`/api/v1/apps/${appId}/manifest`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ excludedCapabilities }),
      });
      const data = await readFetchJson(res);
      if (!data.ok) {
        setError(
          typeof data.body.error === "string"
            ? data.body.error
            : `Failed to save (${res.status})`,
        );
        return;
      }
      await onSaved();
      setExpanded(false);
      setSynced(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const resetToDefault = async () => {
    if (!canEdit) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/apps/${appId}/manifest`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ excludedCapabilities: [] }),
      });
      const data = await readFetchJson(res);
      if (!data.ok) {
        setError(
          typeof data.body.error === "string"
            ? data.body.error
            : `Failed to reset (${res.status})`,
        );
        return;
      }
      await onSaved();
      setExpanded(false);
      setSynced(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reset");
    } finally {
      setSaving(false);
    }
  };

  const exclusionCount = pickerReady
    ? excludedDocumentFromPickerValues(catalogLite, pickerValues).length
    : null;

  const collapsedEditable = canEdit && !expanded;

  return (
    <article
      className={`group relative rounded-xl border border-emerald-500/25 bg-zinc-900/40 p-5 space-y-3 transition-colors ${
        collapsedEditable ? "hover:border-emerald-500/40 hover:bg-zinc-900/50" : ""
      }`}
    >
      <CollapsedPlanCardHitArea
        enabled={collapsedEditable}
        ariaLabel="Edit network discovery"
        onActivate={openEdit}
      />
      <div
        className={`relative z-10 flex items-start justify-between gap-4 ${
          collapsedEditable ? "pointer-events-none" : ""
        }`}
      >
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold text-zinc-100 flex flex-wrap items-center gap-2">
            {planDisplayName({ name: plan.name, isNetworkDefault: true })}
            <span className="text-[10px] font-medium uppercase tracking-wide text-emerald-400/90 border border-emerald-500/30 rounded px-1.5 py-0.5">
              Default
            </span>
          </h3>
          <p className="text-xs text-zinc-500 mt-1">
            Choose which pipelines and models are discoverable for users of this app
          </p>
          {!expanded && (
            <p className="text-sm text-zinc-300 mt-2">{discoverySummary}</p>
          )}
        </div>
        {collapsedEditable && (
          <span className="shrink-0 text-sm font-medium text-emerald-400 group-hover:text-emerald-300">
            Edit discovery
          </span>
        )}
      </div>

      {error && (
        <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
          {error}
        </p>
      )}
      {catalogError && (
        <p className="text-xs text-amber-400">
          {catalogError} — reload when the catalog is reachable.
        </p>
      )}
      {excludesEntireCatalog && (
        <p className="text-xs text-amber-300/90 bg-amber-500/10 border border-amber-500/25 rounded-lg px-3 py-2">
          Every pipeline/model is excluded. Integrators stay fail-open until at least one remains
          allowed.
        </p>
      )}

      {expanded && (
        <div className="space-y-3">
          {catalog.length > 0 ? (
            <>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={!canEdit || saving}
                  onClick={() => setPickerValues(allCatalogPickerValues(catalog))}
                  className="text-xs px-2.5 py-1 rounded-md border border-zinc-600 text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                >
                  Select all
                </button>
                <button
                  type="button"
                  disabled={!canEdit || saving}
                  onClick={() => setPickerValues([])}
                  className="text-xs px-2.5 py-1 rounded-md border border-zinc-600 text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                >
                  Unselect all
                </button>
              </div>
              <div className="block text-xs text-zinc-500">
                Pipelines &amp; models discoverable to integrators
                <span className="block text-zinc-600 mt-0.5">
                  Per-capability price limits coming soon.
                </span>
              </div>
              <PipelineModelPicker
                catalog={catalog}
                values={pickerValues}
                onChange={setPickerValues}
                disabled={!canEdit || saving}
              />
              {pickerReady && exclusionCount != null && (
                <p className="text-xs text-zinc-600">
                  {exclusionCount} exclusion{exclusionCount === 1 ? "" : "s"} from full catalog.
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-zinc-500">Catalog unavailable — cannot edit picker.</p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void saveDiscovery()}
              disabled={!canEdit || saving || !catalog.length || !synced}
              className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm hover:bg-emerald-500 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save discovery"}
            </button>
            <button
              type="button"
              onClick={discard}
              disabled={saving}
              className="px-4 py-2 rounded-lg border border-zinc-600 text-zinc-200 text-sm hover:bg-zinc-800 disabled:opacity-50"
            >
              Discard
            </button>
            <button
              type="button"
              onClick={() => void resetToDefault()}
              disabled={!canEdit || saving}
              className="px-4 py-2 rounded-lg border border-zinc-600 text-zinc-400 text-sm hover:bg-zinc-800 disabled:opacity-50"
            >
              Reset to all discoverable
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

// ── Starter plan card ─────────────────────────────────────────────────────────

function StarterPlanCard({
  appId,
  plan,
  canEdit,
  onSaved,
}: Readonly<{
  appId: string;
  plan: PlanRow;
  canEdit: boolean;
  onSaved: () => void | Promise<void>;
}>) {
  const [expanded, setExpanded] = useState(false);
  const [includedUsdDisplay, setIncludedUsdDisplay] = useState(() =>
    usdMicrosToCentsDisplay(plan.includedUsdMicros ?? "5000000"),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const syncFailure = planSyncFailureMessage(plan);

  useEffect(() => {
    if (expanded) {
      setIncludedUsdDisplay(usdMicrosToCentsDisplay(plan.includedUsdMicros ?? "5000000"));
      setError(null);
    }
  }, [expanded, plan.includedUsdMicros]);

  const save = async () => {
    if (!canEdit) return;
    const micros = usdCentsDisplayToMicros(includedUsdDisplay);
    if (micros == null) {
      setError("Allowance must be a valid dollar amount (e.g. 5.00)");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/apps/${appId}/starter-plan`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ includedUsdMicros: micros }),
      });
      const data = await readFetchJson(res);
      if (!data.ok) {
        setError(
          typeof data.body.error === "string"
            ? data.body.error
            : `Failed to save (${res.status})`,
        );
        return;
      }
      if (typeof data.body.syncError === "string" && data.body.syncError.trim()) {
        setError(`Saved, but OpenMeter sync failed: ${data.body.syncError}`);
        await onSaved();
        return;
      }
      await onSaved();
      setExpanded(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const collapsedEditable = canEdit && !expanded;

  return (
    <article
      className={`group relative rounded-xl border border-sky-500/25 bg-zinc-900/40 p-5 space-y-3 transition-colors ${
        collapsedEditable ? "hover:border-sky-500/40 hover:bg-zinc-900/50" : ""
      }`}
    >
      <CollapsedPlanCardHitArea
        enabled={collapsedEditable}
        ariaLabel="Edit Starter allowance"
        onActivate={() => setExpanded(true)}
      />
      <div
        className={`relative z-10 flex items-start justify-between gap-4 ${
          collapsedEditable ? "pointer-events-none" : ""
        }`}
      >
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold text-zinc-100 flex flex-wrap items-center gap-2">
            {planDisplayNameWithStarter({
              name: plan.name,
              isNetworkDefault: false,
              isStarterDefault: true,
            })}
            <span className="text-[10px] font-medium uppercase tracking-wide text-sky-400/90 border border-sky-500/30 rounded px-1.5 py-0.5">
              Free tier
            </span>
          </h3>
          <p className="text-xs text-zinc-500 mt-1">
            Included usage for new end users via OpenMeter subscription entitlements (network
            pass-through pricing)
          </p>
          {!expanded && plan.includedUsdMicros && (
            <p className="text-sm text-sky-300/90 mt-2">
              {formatUsdMicrosDisplay(plan.includedUsdMicros)} included per billing period
            </p>
          )}
          {syncFailure && (
            <p className="text-xs mt-1 text-red-400">{syncFailure}</p>
          )}
        </div>
        {collapsedEditable && (
          <span className="shrink-0 text-sm font-medium text-sky-400 group-hover:text-sky-300">
            Edit allowance
          </span>
        )}
      </div>

      {error && (
        <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
          {error}
        </p>
      )}

      {expanded && (
        <div className="relative z-10 space-y-3 border-t border-zinc-800 pt-3">
          <div>
            <label htmlFor="starter-included-usd" className="block text-sm text-zinc-300 mb-1">
              Included usage allowance
            </label>
            <DollarCentsInput
              id="starter-included-usd"
              value={includedUsdDisplay}
              onChange={setIncludedUsdDisplay}
              disabled={!canEdit}
              aria-label="Included usage allowance in dollars"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={!canEdit || saving}
              className="px-4 py-2 rounded-lg bg-sky-600 text-white text-sm hover:bg-sky-500 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => {
                setExpanded(false);
                setError(null);
              }}
              disabled={saving}
              className="px-4 py-2 rounded-lg border border-zinc-600 text-zinc-200 text-sm hover:bg-zinc-800 disabled:opacity-50"
            >
              Discard
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

// ── Custom plan card ──────────────────────────────────────────────────────────

function CustomPlanCard({
  appId,
  plan,
  catalog,
  catalogError,
  blockedConcreteKeys,
  canEdit,
  isEditing,
  onEdit,
  onCancelEdit,
  onSaved,
  onDelete,
}: {
  appId: string;
  plan: PlanRow;
  catalog: PipelineCatalogEntry[];
  catalogError: string | null;
  blockedConcreteKeys: Set<string>;
  canEdit: boolean;
  isEditing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSaved: () => void | Promise<void>;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState<PlanDraft>(() => planToDraft(plan));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const syncFailure = planSyncFailureMessage(plan);

  useEffect(() => {
    if (isEditing) {
      setDraft(planToDraft(plan));
      setError(null);
    }
  }, [isEditing, plan]);

  const save = async () => {
    if (!canEdit || !draft.name.trim()) return;
    const nameCheck = validateCustomPlanName(draft.name);
    if (!nameCheck.ok) {
      setError(nameCheck.error);
      return;
    }
    const capabilityError = openMeterCapabilityValidationError(appId, plan.id, draft);
    if (capabilityError) {
      setError(capabilityError);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/apps/${appId}/plans`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPlanPayload(draft, plan.id, plan)),
      });
      const data = await readFetchJson(res);
      if (!data.ok) {
        setError(
          typeof data.body.error === "string"
            ? data.body.error
            : `Failed to save (${res.status})`,
        );
        return;
      }
      if (typeof data.body.syncError === "string" && data.body.syncError.trim()) {
        setError(`Saved, but OpenMeter sync failed: ${data.body.syncError}`);
        await onSaved();
        return;
      }
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const collapsedEditable = canEdit && !isEditing;
  const saveButtonLabel = saving ? "Saving…" : "Save plan";

  return (
    <article
      className={`relative rounded-xl border border-zinc-800 bg-zinc-900/30 p-5 space-y-3 transition-colors ${
        collapsedEditable ? "hover:border-zinc-700 hover:bg-zinc-900/50" : ""
      }`}
    >
      <CollapsedPlanCardHitArea
        enabled={collapsedEditable}
        ariaLabel={`Edit plan ${plan.name}`}
        onActivate={onEdit}
      />
      <div
        className={`relative z-10 flex items-start justify-between gap-4 ${
          collapsedEditable ? "pointer-events-none" : ""
        }`}
      >
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold text-zinc-100 flex flex-wrap items-center gap-2">
            {plan.name}
            <TypeBadge type={plan.type} />
          </h3>
          {plan.type === "subscription" && (
            <p className="text-xs text-zinc-500 mt-1">
              {`${plan.priceAmount} ${plan.priceCurrency}`}
              {plan.billingCycle && ` · ${plan.billingCycle}`}
            </p>
          )}
          {plan.includedUsdMicros && (
            <p className="text-xs text-emerald-400/80 mt-1">
              Includes {formatUsdMicrosDisplay(plan.includedUsdMicros)} usage
            </p>
          )}
          {plan.type !== "free" && !plan.isNetworkDefault && syncFailure && (
            <p className="text-xs mt-1 text-red-400">{syncFailure}</p>
          )}
          {!isEditing && (
            <CapabilityChips capabilities={plan.capabilities} catalog={catalog} />
          )}
        </div>
        {collapsedEditable && (
          <div className="flex shrink-0 gap-3 pointer-events-auto">
            <span className="text-sm font-medium text-emerald-400">Edit</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              className="text-sm text-zinc-500 hover:text-red-400"
            >
              Delete
            </button>
          </div>
        )}
      </div>

      {error && (
        <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
          {error}
        </p>
      )}

      {isEditing && (
        <>
          <PlanDraftForm
            draft={draft}
            onChange={setDraft}
            catalog={catalog}
            catalogError={catalogError}
            blockedConcreteKeys={blockedConcreteKeys}
            canEdit={canEdit}
            idPrefix={`plan-${plan.id}`}
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || !draft.name.trim()}
              className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm hover:bg-emerald-500 disabled:opacity-50"
            >
              {saveButtonLabel}
            </button>
            <button
              type="button"
              onClick={onCancelEdit}
              disabled={saving}
              className="px-4 py-2 rounded-lg border border-zinc-600 text-zinc-200 text-sm hover:bg-zinc-800 disabled:opacity-50"
            >
              Discard
            </button>
          </div>
          <p className="text-xs text-zinc-500">
            Saving paid plans publishes retail $/micro rate cards to OpenMeter. Use Usage API
            with <code className="text-zinc-400">?include=retail&amp;groupBy=pipeline_model</code>{" "}
            to validate effective rates.
          </p>
        </>
      )}
    </article>
  );
}

// ── Add plan panel ────────────────────────────────────────────────────────────

function AddPlanPanel({
  appId,
  catalog,
  catalogError,
  blockedConcreteKeys,
  canEdit,
  onCreated,
}: {
  appId: string;
  catalog: PipelineCatalogEntry[];
  catalogError: string | null;
  blockedConcreteKeys: Set<string>;
  canEdit: boolean;
  onCreated: () => void | Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<PlanDraft>(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (!canEdit || !draft.name.trim()) return;
    const nameCheck = validateCustomPlanName(draft.name);
    if (!nameCheck.ok) {
      setError(nameCheck.error);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/apps/${appId}/plans`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPlanPayload(draft, undefined, null)),
      });
      const data = await readFetchJson(res);
      if (!data.ok) {
        setError(
          typeof data.body.error === "string"
            ? data.body.error
            : `Failed to create (${res.status})`,
        );
        return;
      }
      if (typeof data.body.syncError === "string" && data.body.syncError.trim()) {
        setError(`Created, but OpenMeter sync failed: ${data.body.syncError}`);
        await onCreated();
        return;
      }
      setDraft(emptyDraft());
      setExpanded(false);
      await onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create plan");
    } finally {
      setSaving(false);
    }
  };

  if (!canEdit) return null;

  const createButtonLabel = saving ? "Creating…" : "Create plan";

  const openCreate = () => {
    setError(null);
    setExpanded(true);
  };

  return (
    <article
      className={`relative rounded-xl border border-dashed border-zinc-700 bg-zinc-900/20 p-5 transition-colors ${
        !expanded ? "hover:border-zinc-600 hover:bg-zinc-900/30" : ""
      }`}
    >
      {!expanded ? (
        <>
          <CollapsedPlanCardHitArea
            enabled
            ariaLabel="Add custom plan"
            onActivate={openCreate}
          />
          <div className="relative z-10 flex items-center justify-end pointer-events-none">
            <span className="text-sm font-medium text-emerald-400">+ Add custom plan</span>
          </div>
        </>
      ) : (
        <div className="space-y-4">
          <h3 className="text-base font-semibold text-zinc-100">New custom plan</h3>
          {error && (
            <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {error}
            </p>
          )}
          <PlanDraftForm
            draft={draft}
            onChange={setDraft}
            catalog={catalog}
            catalogError={catalogError}
            blockedConcreteKeys={blockedConcreteKeys}
            canEdit={canEdit}
            idPrefix="new-plan"
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void create()}
              disabled={saving || !draft.name.trim()}
              className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm hover:bg-emerald-500 disabled:opacity-50"
            >
              {createButtonLabel}
            </button>
            <button
              type="button"
              onClick={() => {
                setExpanded(false);
                setDraft(emptyDraft());
                setError(null);
              }}
              disabled={saving}
              className="px-4 py-2 rounded-lg border border-zinc-600 text-zinc-200 text-sm hover:bg-zinc-800 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

// ── Main PlansTab Component ───────────────────────────────────────────────────

interface PlansTabProps {
  appId: string;
  canEdit: boolean;
}

export default function PlansTab({ appId, canEdit }: PlansTabProps) {
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [catalog, setCatalog] = useState<PipelineCatalogEntry[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [planError, setPlanError] = useState<string | null>(null);
  const [editingPlanId, setEditingPlanId] = useState<string | null>(null);

  const catalogLite = useMemo(() => catalogLiteFrom(catalog), [catalog]);

  const networkPlan = useMemo(
    () => plans.find((p) => p.isNetworkDefault === true),
    [plans],
  );

  const starterPlan = useMemo(
    () => plans.find((p) => p.isStarterDefault === true),
    [plans],
  );

  const customPlans = useMemo(
    () => plans.filter((p) => p.isNetworkDefault !== true && p.isStarterDefault !== true),
    [plans],
  );

  const blockedConcreteKeys = useMemo(() => {
    const doc = normalizeDiscoveryAllowlistDoc(
      networkPlan?.discoveryExcludedCapabilities ?? null,
    );
    if (!doc || !catalogLite.length) return new Set<string>();
    return expandDocumentToConcreteKeys(doc, catalogLite);
  }, [networkPlan, catalogLite]);

  const fetchPlans = useCallback(async () => {
    try {
      const plansWrap = await fetch(
        `/api/v1/apps/${appId}/plans?includeInternals=true`,
      ).then(readFetchJson);
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
    } catch (err) {
      setPlans([]);
      setPlanError(err instanceof Error ? err.message : "Failed to load plans");
    } finally {
      setLoading(false);
    }
  }, [appId]);

  const reloadPlans = useCallback(() => {
    setLoading(true);
    void fetchPlans();
  }, [fetchPlans]);

  const refreshCustomPlans = useCallback(async () => {
    try {
      const plansWrap = await fetch(
        `/api/v1/apps/${appId}/plans?includeInternals=true`,
      ).then(readFetchJson);
      if (plansWrap.ok && Array.isArray(plansWrap.body.plans)) {
        const nextPlans = plansWrap.body.plans as PlanRow[];
        const nextCustomPlans = nextPlans.filter(
          (p) => p.isNetworkDefault !== true && p.isStarterDefault !== true,
        );
        setPlans((prevPlans) => {
          const previousNetworkPlan = prevPlans.find((p) => p.isNetworkDefault === true);
          const previousStarterPlan = prevPlans.find((p) => p.isStarterDefault === true);
          const reserved = [previousNetworkPlan, previousStarterPlan].filter(
            (p): p is PlanRow => Boolean(p),
          );
          if (reserved.length === 0) {
            return nextPlans;
          }
          return [...reserved, ...nextCustomPlans];
        });
        setPlanError(null);
      } else {
        const msg =
          typeof plansWrap.body.error === "string"
            ? plansWrap.body.error
            : `Could not refresh plans (HTTP ${plansWrap.status})`;
        setPlanError(msg);
      }
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : "Failed to refresh plans");
    }
  }, [appId]);

  useEffect(() => {
    void fetchPlans();
  }, [fetchPlans]);

  useEffect(() => {
    fetch("/api/v1/pipeline-catalog")
      .then(readFetchJson)
      .then(({ ok, status, body }) => {
        const cat = body.catalog;
        if (Array.isArray(cat) && cat.length > 0) {
          setCatalog(cat as PipelineCatalogEntry[]);
          setCatalogError(null);
        } else if (Array.isArray(cat) && cat.length === 0) {
          setCatalog([]);
          setCatalogError("Pipeline catalog is empty");
        } else if (typeof body.error === "string") {
          setCatalogError(body.error);
        } else if (!ok) {
          setCatalogError(`Pipeline catalog unavailable (HTTP ${status})`);
        }
      })
      .catch(() => setCatalogError("NaaP catalog unavailable"));
  }, []);

  const deletePlan = async (planId: string) => {
    if (!canEdit) return;
    const plan = plans.find((p) => p.id === planId);
    if (
      !confirm(
        `Delete plan "${plan ? planDisplayNameWithStarter({ name: plan.name, isNetworkDefault: plan.isNetworkDefault === true, isStarterDefault: plan.isStarterDefault === true }) : planId}"? This cannot be undone.`,
      )
    ) {
      return;
    }
    try {
      const res = await fetch(
        `/api/v1/apps/${appId}/plans?planId=${encodeURIComponent(planId)}`,
        { method: "DELETE" },
      );
      const data = await readFetchJson(res);
      if (!data.ok) {
        setPlanError(
          typeof data.body.error === "string"
            ? data.body.error
            : `Failed to delete plan (${res.status})`,
        );
        return;
      }
      if (editingPlanId === planId) setEditingPlanId(null);
      await refreshCustomPlans();
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : "Failed to delete plan");
    }
  };

  const handleNetworkSaved = () => {
    setEditingPlanId(null);
    reloadPlans();
  };

  const handleCustomPlanSaved = async () => {
    setEditingPlanId(null);
    await refreshCustomPlans();
  };

  return (
    <div className="pb-6">
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-zinc-100">Plans &amp; network discovery</h2>
        <p className="text-sm text-zinc-500 mt-1">
          Control which pipelines and models are discoverable for your app&apos;s gateway clients.
          Enabled capabilities are priced at the live network market rate. Use custom plans to apply
          reseller markup on specific pipeline/model capabilities.
        </p>
        {!canEdit && (
          <p className="text-sm text-amber-400/90 mt-2">
            View only — only platform or app administrators can edit plans.
          </p>
        )}
        {planError && (
          <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 mt-2">
            {planError}
          </p>
        )}
      </div>

      {loading ? (
        <div className="text-zinc-500 animate-pulse py-8">Loading plans…</div>
      ) : (
        <div className="space-y-4">
          {networkPlan ? (
            <NetworkPricePlanCard
              appId={appId}
              plan={networkPlan}
              catalog={catalog}
              catalogError={catalogError}
              canEdit={canEdit}
              onSaved={handleNetworkSaved}
            />
          ) : (
            <p className="text-sm text-amber-400">Network Price plan not found for this app.</p>
          )}

          {starterPlan ? (
            <StarterPlanCard
              appId={appId}
              plan={starterPlan}
              canEdit={canEdit}
              onSaved={reloadPlans}
            />
          ) : (
            <p className="text-sm text-amber-400">Starter plan not found for this app.</p>
          )}

          {customPlans.map((plan) => (
            <CustomPlanCard
              key={plan.id}
              appId={appId}
              plan={plan}
              catalog={catalog}
              catalogError={catalogError}
              blockedConcreteKeys={blockedConcreteKeys}
              canEdit={canEdit}
              isEditing={editingPlanId === plan.id}
              onEdit={() => setEditingPlanId(plan.id)}
              onCancelEdit={() => setEditingPlanId(null)}
              onSaved={handleCustomPlanSaved}
              onDelete={() => void deletePlan(plan.id)}
            />
          ))}

          <AddPlanPanel
            appId={appId}
            catalog={catalog}
            catalogError={catalogError}
            blockedConcreteKeys={blockedConcreteKeys}
            canEdit={canEdit}
            onCreated={handleCustomPlanSaved}
          />
        </div>
      )}
    </div>
  );
}
