"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

export interface PipelineCatalogEntry {
  id: string;
  name: string;
  models: string[];
}

interface PipelineModelPickerProps {
  catalog: PipelineCatalogEntry[];
  /** Each value is either "pipelineId" (wildcard all models) or "pipelineId|modelId" */
  values: string[];
  onChange: (values: string[]) => void;
  disabled?: boolean;
}

type PipelineCheckState = "none" | "some" | "all-individual" | "wildcard";

export default function PipelineModelPicker({
  catalog,
  values,
  onChange,
  disabled = false,
}: PipelineModelPickerProps) {
  const inputId = useId();
  const listboxId = `${inputId}-listbox`;
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");

  const close = useCallback(() => {
    setOpen(false);
    setFilter("");
  }, []);

  useEffect(() => {
    if (!disabled) return;
    const timeoutId = window.setTimeout(close, 0);
    return () => window.clearTimeout(timeoutId);
  }, [disabled, close]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: PointerEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        close();
      }
    };
    document.addEventListener("pointerdown", onDoc);
    return () => document.removeEventListener("pointerdown", onDoc);
  }, [open, close]);

  // ── helpers ────────────────────────────────────────────────────────────────

  const isPipelineWildcard = (pipelineId: string) => values.includes(pipelineId);

  const isModelSelected = (pipelineId: string, modelId: string) =>
    values.includes(`${pipelineId}|${modelId}`);

  const pipelineCheckState = (entry: PipelineCatalogEntry): PipelineCheckState => {
    if (isPipelineWildcard(entry.id)) return "wildcard";
    const selectedCount = entry.models.filter((m) =>
      isModelSelected(entry.id, m),
    ).length;
    if (selectedCount === 0) return "none";
    if (selectedCount === entry.models.length) return "all-individual";
    return "some";
  };

  const togglePipeline = (entry: PipelineCatalogEntry) => {
    if (disabled) return;
    if (isPipelineWildcard(entry.id)) {
      onChange(values.filter((v) => v !== entry.id));
    } else {
      // Select wildcard and clear any individual model keys for this pipeline
      const without = values.filter(
        (v) => v !== entry.id && !v.startsWith(`${entry.id}|`),
      );
      onChange([...without, entry.id]);
    }
  };

  const toggleModel = (entry: PipelineCatalogEntry, modelId: string) => {
    if (disabled || isPipelineWildcard(entry.id)) return;
    const key = `${entry.id}|${modelId}`;
    if (values.includes(key)) {
      onChange(values.filter((v) => v !== key));
    } else {
      onChange([...values, key]);
    }
  };

  const removeValue = (value: string) => onChange(values.filter((v) => v !== value));

  const chipLabel = (value: string) => {
    if (!value.includes("|")) {
      const entry = catalog.find((e) => e.id === value);
      return `${entry?.name ?? value} · all models`;
    }
    const sep = value.indexOf("|");
    const pipelineId = value.slice(0, sep);
    const modelId = value.slice(sep + 1);
    const entry = catalog.find((e) => e.id === pipelineId);
    return `${entry?.name ?? pipelineId} · ${modelId}`;
  };

  // ── filtering ──────────────────────────────────────────────────────────────

  const q = filter.trim().toLowerCase();
  const filteredCatalog = catalog
    .map((entry) => {
      if (!q) return { ...entry, filteredModels: entry.models };
      const pipelineMatches = entry.name.toLowerCase().includes(q);
      const filteredModels = pipelineMatches
        ? entry.models
        : entry.models.filter((m) => m.toLowerCase().includes(q));
      if (!pipelineMatches && filteredModels.length === 0) return null;
      return { ...entry, filteredModels };
    })
    .filter(Boolean) as Array<PipelineCatalogEntry & { filteredModels: string[] }>;

  // ── render ─────────────────────────────────────────────────────────────────

  return (
    <div ref={containerRef} className="relative w-full">
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {values.map((v) => (
            <span
              key={v}
              className="inline-flex items-center gap-1 max-w-full rounded-full bg-zinc-700 px-2 py-0.5 text-xs text-zinc-100"
            >
              <span className="truncate">{chipLabel(v)}</span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => removeValue(v)}
                className="shrink-0 rounded p-0.5 text-zinc-400 hover:bg-zinc-600 hover:text-zinc-100 disabled:opacity-40"
                aria-label={`Remove ${chipLabel(v)}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <input
        ref={inputRef}
        id={inputId}
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-autocomplete="list"
        value={open ? filter : ""}
        placeholder={disabled ? "" : "Search pipelines and models…"}
        disabled={disabled}
        onChange={(e) => {
          setFilter(e.target.value);
          if (!open) setOpen(true);
        }}
        onFocus={() => {
          if (!disabled) setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
        }}
        className="w-full px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-sm text-zinc-100 placeholder:text-zinc-500 disabled:opacity-50"
      />

      {open && (
        <div
          id={listboxId}
          role="listbox"
          aria-multiselectable="true"
          className="absolute z-50 mt-1 w-full max-h-72 overflow-auto rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-lg"
        >
          {filteredCatalog.length === 0 ? (
            <div className="px-3 py-2 text-sm text-zinc-500">No matches</div>
          ) : (
            filteredCatalog.map((entry) => {
              const state = pipelineCheckState(entry);
              const isWildcard = state === "wildcard";

              return (
                <div key={entry.id}>
                  {/* Pipeline row */}
                  <button
                    type="button"
                    role="option"
                    aria-selected={isWildcard}
                    disabled={disabled}
                    onClick={() => togglePipeline(entry)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-zinc-200 hover:bg-zinc-800"
                  >
                    <PipelineCheckMark state={state} />
                    <span className="font-medium flex-1">{entry.name}</span>
                    {isWildcard && (
                      <span className="text-[10px] text-emerald-400/70 font-normal shrink-0">
                        all models
                      </span>
                    )}
                  </button>

                  {/* Model rows */}
                  {entry.filteredModels.map((modelId) => {
                    const modelChecked = isModelSelected(entry.id, modelId);
                    return (
                      <button
                        key={modelId}
                        type="button"
                        role="option"
                        aria-selected={modelChecked || isWildcard}
                        onClick={() => toggleModel(entry, modelId)}
                        disabled={disabled || isWildcard}
                        className={`w-full flex items-center gap-2 pl-7 pr-3 py-1.5 text-left text-xs ${
                          isWildcard
                            ? "text-zinc-600 cursor-default"
                            : "text-zinc-300 hover:bg-zinc-800"
                        }`}
                      >
                        <ModelCheckMark checked={modelChecked} implicit={isWildcard} />
                        <span className="truncate">{modelId}</span>
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

function PipelineCheckMark({ state }: { state: PipelineCheckState }) {
  const base = "flex-shrink-0 w-3.5 h-3.5 rounded border flex items-center justify-center text-[9px] font-bold leading-none";
  if (state === "wildcard") {
    return <span className={`${base} border-emerald-600 bg-emerald-600 text-white`}>✓</span>;
  }
  if (state === "all-individual") {
    return <span className={`${base} border-zinc-400 bg-zinc-600 text-white`}>✓</span>;
  }
  if (state === "some") {
    return <span className={`${base} border-zinc-500 bg-zinc-800 text-zinc-400`}>—</span>;
  }
  return <span className={`${base} border-zinc-600 bg-transparent`} />;
}

function ModelCheckMark({ checked, implicit }: { checked: boolean; implicit: boolean }) {
  const base = "flex-shrink-0 w-3 h-3 rounded border flex items-center justify-center text-[8px] font-bold leading-none";
  if (implicit) {
    return <span className={`${base} border-zinc-700 bg-zinc-800 text-zinc-600`}>✓</span>;
  }
  if (checked) {
    return <span className={`${base} border-emerald-600 bg-emerald-600 text-white`}>✓</span>;
  }
  return <span className={`${base} border-zinc-600 bg-transparent`} />;
}
