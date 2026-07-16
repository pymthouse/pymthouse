"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

export type AppFilterOption = {
  value: string;
  label: string;
};

function filterButtonLabel(
  options: AppFilterOption[],
  selectedValues: string[],
): string {
  if (options.length === 0) {
    return "No applications";
  }
  if (selectedValues.length === 0) {
    return "No applications";
  }
  if (selectedValues.length === options.length) {
    return "All applications";
  }
  if (selectedValues.length === 1) {
    return options.find((o) => o.value === selectedValues[0])?.label ?? "1 app";
  }
  return `${selectedValues.length} apps`;
}

/**
 * Compact multi-select for filtering Dashboard usage by application.
 * Defaults to all selected; "Select all" restores that state.
 */
export default function AppFilterDropdown({
  options,
  selectedValues,
  onChange,
}: Readonly<{
  options: AppFilterOption[];
  selectedValues: string[];
  onChange: (values: string[]) => void;
}>) {
  const listId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        close();
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, close]);

  const allSelected =
    options.length > 0 && selectedValues.length === options.length;
  const selectedSet = new Set(selectedValues);

  const toggleValue = (value: string) => {
    if (selectedSet.has(value)) {
      onChange(selectedValues.filter((v) => v !== value));
    } else {
      onChange([...selectedValues, value]);
    }
  };

  const selectAll = () => onChange(options.map((o) => o.value));
  const clearAll = () => onChange([]);

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:border-zinc-600 hover:bg-zinc-800/80"
      >
        <span className="text-zinc-500">Apps</span>
        <span className="max-w-[12rem] truncate">{filterButtonLabel(options, selectedValues)}</span>
        <svg
          className={`h-3.5 w-3.5 text-zinc-500 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open ? (
        <div
          id={listId}
          className="absolute right-0 z-50 mt-1 w-64 max-h-72 overflow-auto rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-lg"
        >
          <div className="flex items-center justify-between gap-2 border-b border-zinc-800 px-3 py-2">
            <button
              type="button"
              onClick={selectAll}
              disabled={allSelected}
              className="text-[11px] font-medium text-emerald-400 hover:text-emerald-300 disabled:cursor-default disabled:text-zinc-600"
            >
              Select all
            </button>
            <button
              type="button"
              onClick={clearAll}
              disabled={selectedValues.length === 0}
              className="text-[11px] font-medium text-zinc-400 hover:text-zinc-200 disabled:cursor-default disabled:text-zinc-600"
            >
              Clear
            </button>
          </div>

          {options.length === 0 ? (
            <p className="px-3 py-3 text-sm text-zinc-500">No applications</p>
          ) : (
            <fieldset className="relative m-0 border-0 p-0">
              <legend className="absolute h-px w-px overflow-hidden whitespace-nowrap p-0 [clip:rect(0,0,0,0)]">
                Filter by application
              </legend>
              {options.map((opt) => {
                const selected = selectedSet.has(opt.value);
                const checkboxId = `${listId}-${opt.value}`;
                return (
                  <label
                    key={opt.value}
                    htmlFor={checkboxId}
                    className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm text-zinc-200 hover:bg-zinc-800"
                  >
                    <input
                      id={checkboxId}
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggleValue(opt.value)}
                      className="h-3.5 w-3.5 shrink-0 rounded border-zinc-600 bg-zinc-900 text-emerald-600 focus:ring-emerald-500/40"
                    />
                    <span className="truncate">{opt.label}</span>
                  </label>
                );
              })}
            </fieldset>
          )}
        </div>
      ) : null}
    </div>
  );
}
