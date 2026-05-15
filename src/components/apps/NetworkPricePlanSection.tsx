"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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

interface Props {
  appId: string;
  canEdit: boolean;
}

/**
 * Network Price default plan: integrator discovery exclusions + catalog picker.
 */
export default function NetworkPricePlanSection({ appId, canEdit }: Props) {
  const [catalog, setCatalog] = useState<PipelineCatalogEntry[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [pickerValues, setPickerValues] = useState<string[]>([]);
  const [excludedDoc, setExcludedDoc] = useState<ReturnType<
    typeof normalizeDiscoveryAllowlistDoc
  > | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const catalogLite = useMemo(
    () => catalog.map((e) => ({ id: e.id, models: e.models })),
    [catalog],
  );

  const excludesEntireCatalog = useMemo(() => {
    if (!catalogLite.length) return false;
    const doc = excludedDocumentFromPickerValues(catalogLite, pickerValues);
    const normalized = normalizeDiscoveryAllowlistDoc({ capabilities: doc });
    if (isDiscoveryDocumentEmpty(normalized)) return false;
    const ex = expandDocumentToConcreteKeys(normalized!, catalogLite);
    return ex.size === fullCatalogConcreteKeys(catalogLite).size;
  }, [catalogLite, pickerValues]);

  const loadAllowlist = useCallback(() => {
    setLoading(true);
    fetch(`/api/v1/apps/${appId}/discovery-allowlist`)
      .then(readFetchJson)
      .then((allowWrap) => {
        if (!allowWrap.ok) {
          setError(
            typeof allowWrap.body.error === "string"
              ? allowWrap.body.error
              : `Could not load discovery settings (HTTP ${allowWrap.status})`,
          );
          setExcludedDoc(null);
          return;
        }
        const rawExcluded = allowWrap.body.excludedCapabilities;
        const doc = normalizeDiscoveryAllowlistDoc({
          capabilities: Array.isArray(rawExcluded) ? rawExcluded : [],
        });
        setExcludedDoc(doc);
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load discovery settings");
      })
      .finally(() => setLoading(false));
  }, [appId]);

  useEffect(() => {
    loadAllowlist();
  }, [loadAllowlist]);

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

  useEffect(() => {
    if (loading || !catalogLite.length) return;
    setPickerValues(pickerValuesFromExcludedDocument(catalogLite, excludedDoc));
  }, [loading, catalogLite, excludedDoc]);

  const saveAllowlist = async () => {
    if (!canEdit) return;
    setSaving(true);
    setError(null);
    try {
      const excludedCapabilities = excludedDocumentFromPickerValues(
        catalogLite,
        pickerValues,
      );
      const res = await fetch(`/api/v1/apps/${appId}/discovery-allowlist`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ excludedCapabilities }),
      });
      const data = await readFetchJson(res);
      if (!data.ok) {
        const msg =
          typeof data.body.error === "string"
            ? data.body.error
            : `Failed to save (${res.status})`;
        setError(msg);
        return;
      }
      loadAllowlist();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save discovery settings");
    } finally {
      setSaving(false);
    }
  };

  const resetToDefault = async () => {
    if (!canEdit) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/apps/${appId}/discovery-allowlist`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ excludedCapabilities: [] }),
      });
      const data = await readFetchJson(res);
      if (!data.ok) {
        const msg =
          typeof data.body.error === "string"
            ? data.body.error
            : `Failed to reset (${res.status})`;
        setError(msg);
        return;
      }
      loadAllowlist();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reset");
    } finally {
      setSaving(false);
    }
  };

  const exclusionCount = excludedDocumentFromPickerValues(
    catalogLite,
    pickerValues,
  ).length;

  return (
    <section
      id="network-price"
      className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-6 space-y-4 mb-8"
    >
      <div>
        <h2 className="text-xl font-semibold text-zinc-100">Network Price (default)</h2>
        <p className="text-sm text-zinc-500 mt-1">
          Everything is discoverable by default. Uncheck pipelines or models to exclude them from
          integrator discovery. Custom plans below can only price models that remain discoverable
          here. Type: free · $0 (network-priced models use plan upcharges).
        </p>
        {!canEdit && (
          <p className="text-sm text-amber-400/90 mt-2">
            View only — only platform or app administrators can edit.
          </p>
        )}
        {error && (
          <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 mt-2">
            {error}
          </p>
        )}
      </div>

      {catalogError && (
        <p className="text-xs text-amber-400">
          {catalogError} — reload when the catalog is reachable to use the picker.
        </p>
      )}
      {excludesEntireCatalog && (
        <p className="text-xs text-amber-300/90 bg-amber-500/10 border border-amber-500/25 rounded-lg px-3 py-2">
          You excluded every pipeline/model in the catalog. The client application will treat the
          resolved allow list as empty and stay <strong className="text-amber-200">fail-open</strong>{" "}
          (no restriction) until you <strong className="text-amber-200">remove</strong> exclusions so
          at least one pipeline/model remains allowed for discovery.
        </p>
      )}
      {loading ? (
        <div className="text-zinc-500 animate-pulse">Loading…</div>
      ) : catalog.length > 0 ? (
        <div>
          <label className="block text-xs text-zinc-500 mb-1">
            Pipelines &amp; models discoverable to integrators
          </label>
          <PipelineModelPicker
            catalog={catalog}
            values={pickerValues}
            onChange={setPickerValues}
            disabled={!canEdit}
          />
        </div>
      ) : (
        <p className="text-sm text-zinc-500">
          Pipeline catalog unavailable. Reload when NaaP catalog is reachable, or use the Builder
          API to PUT excludedCapabilities on the discovery-allowlist endpoint.
        </p>
      )}
      <p className="text-xs text-zinc-600">
        {exclusionCount} exclusion{exclusionCount === 1 ? "" : "s"}. Pipeline-level exclusion uses{" "}
        <span className="text-emerald-400/90">model *</span> in stored data; unchecking a whole
        pipeline excludes all its models.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void saveAllowlist()}
          disabled={!canEdit || saving}
          className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm hover:bg-emerald-500 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save discovery"}
        </button>
        <button
          type="button"
          onClick={() => void resetToDefault()}
          disabled={!canEdit || saving}
          className="px-4 py-2 rounded-lg border border-zinc-600 text-zinc-200 text-sm hover:bg-zinc-800 disabled:opacity-50"
        >
          Reset to default
        </button>
      </div>
    </section>
  );
}
