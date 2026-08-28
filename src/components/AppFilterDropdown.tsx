"use client";

import { useCallback, useEffect, useId, useRef, useState, type RefObject } from "react";

import { truncateMiddle } from "@/lib/truncate-middle";

export type AppFilterOption = {
  value: string;
  label: string;
};

export type FilterSearchMatch = "includes" | "startsWith";

export function optionMatchesQuery(
  option: AppFilterOption,
  query: string,
  match: FilterSearchMatch = "includes",
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const value = option.value.toLowerCase();
  const label = option.label.toLowerCase();
  if (match === "startsWith") {
    return value.startsWith(q) || label.startsWith(q);
  }
  return value.includes(q) || label.includes(q);
}

export function visibleFilterOptions(
  options: AppFilterOption[],
  query: string,
  match: FilterSearchMatch,
): AppFilterOption[] {
  if (!query.trim()) return options;
  return options.filter((o) => optionMatchesQuery(o, query, match));
}

export function filterButtonLabel(
  options: AppFilterOption[],
  selectedValues: string[],
  emptyLabel: string,
  allLabel: string,
  maxLabelLength?: number,
): string {
  if (options.length === 0) {
    return emptyLabel;
  }
  if (selectedValues.length === 0) {
    return emptyLabel;
  }
  if (selectedValues.length === options.length) {
    return allLabel;
  }
  if (selectedValues.length === 1) {
    const raw =
      options.find((o) => o.value === selectedValues[0])?.label ?? "1 selected";
    return maxLabelLength ? truncateMiddle(raw, maxLabelLength) : raw;
  }
  return `${selectedValues.length} selected`;
}

function optionDisplayLabel(label: string, maxLabelLength?: number): string {
  return maxLabelLength ? truncateMiddle(label, maxLabelLength) : label;
}

function FilterSearchInput({
  inputRef,
  query,
  placeholder,
  onQueryChange,
  onEscape,
}: Readonly<{
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  placeholder: string;
  onQueryChange: (value: string) => void;
  onEscape: () => void;
}>) {
  return (
    <div className="shrink-0 border-b border-zinc-800 px-2 py-2">
      <input
        ref={inputRef}
        type="search"
        value={query}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onEscape();
          }
        }}
        className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-600/60 focus:outline-none"
      />
    </div>
  );
}

function FilterOptionsList({
  listId,
  legendLabel,
  options,
  selectedSet,
  maxLabelLength,
  emptyLabel,
  onToggle,
}: Readonly<{
  listId: string;
  legendLabel: string;
  options: AppFilterOption[];
  selectedSet: Set<string>;
  maxLabelLength?: number;
  emptyLabel: string;
  onToggle: (value: string) => void;
}>) {
  if (options.length === 0) {
    return <p className="px-3 py-3 text-sm text-zinc-500">{emptyLabel}</p>;
  }
  return (
    <fieldset className="relative m-0 min-h-0 flex-1 overflow-auto border-0 p-0">
      <legend className="absolute h-px w-px overflow-hidden whitespace-nowrap p-0 [clip:rect(0,0,0,0)]">
        {legendLabel}
      </legend>
      {options.map((opt) => {
        const selected = selectedSet.has(opt.value);
        const checkboxId = `${listId}-${opt.value}`;
        const shown = optionDisplayLabel(opt.label, maxLabelLength);
        return (
          <label
            key={opt.value}
            htmlFor={checkboxId}
            title={opt.label}
            className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm text-zinc-200 hover:bg-zinc-800"
          >
            <input
              id={checkboxId}
              type="checkbox"
              checked={selected}
              onChange={() => onToggle(opt.value)}
              className="h-3.5 w-3.5 shrink-0 rounded border-zinc-600 bg-zinc-900 text-emerald-600 focus:ring-emerald-500/40"
            />
            <span
              className={`min-w-0 ${
                maxLabelLength ? "font-mono text-xs whitespace-nowrap" : "truncate"
              }`}
            >
              {shown}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

/**
 * Compact multi-select for filtering Dashboard lists by application/source.
 * Defaults to all selected; "Select all" restores that state.
 */
export default function AppFilterDropdown({
  options,
  selectedValues,
  onChange,
  label = "Apps",
  emptyLabel = "No applications",
  allLabel = "All applications",
  legendLabel,
  searchable = false,
  searchPlaceholder = "Search…",
  searchMatch = "includes",
  maxLabelLength,
}: Readonly<{
  options: AppFilterOption[];
  selectedValues: string[];
  onChange: (values: string[]) => void;
  /** Short prefix shown on the closed button (e.g. "Apps", "Source"). */
  label?: string;
  emptyLabel?: string;
  allLabel?: string;
  /** Visually hidden fieldset legend; defaults from `label`. */
  legendLabel?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  searchMatch?: FilterSearchMatch;
  /** Middle-ellipsis labels longer than this (start and end stay visible). */
  maxLabelLength?: number;
}>) {
  const listId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);

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

  useEffect(() => {
    if (open && searchable) {
      searchRef.current?.focus();
    }
  }, [open, searchable]);

  const allSelected =
    options.length > 0 && selectedValues.length === options.length;
  const selectedSet = new Set(selectedValues);
  const visibleOptions = searchable
    ? visibleFilterOptions(options, query, searchMatch)
    : options;

  const toggleValue = (value: string) => {
    if (selectedSet.has(value)) {
      onChange(selectedValues.filter((v) => v !== value));
    } else {
      onChange([...selectedValues, value]);
    }
  };

  const selectAll = () => onChange(options.map((o) => o.value));
  const clearAll = () => onChange([]);
  const buttonLabel = filterButtonLabel(
    options,
    selectedValues,
    emptyLabel,
    allLabel,
    maxLabelLength,
  );
  const buttonTitle =
    selectedValues.length === 1
      ? (options.find((o) => o.value === selectedValues[0])?.label ?? buttonLabel)
      : buttonLabel;

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => {
          if (open) close();
          else setOpen(true);
        }}
        title={buttonTitle}
        className="inline-flex items-center gap-2 rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:border-zinc-600 hover:bg-zinc-800/80"
      >
        <span className="text-zinc-500">{label}</span>
        <span className={`max-w-[12rem] ${maxLabelLength ? "font-mono whitespace-nowrap" : "truncate"}`}>
          {buttonLabel}
        </span>
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
          className={`absolute right-0 z-50 mt-1 flex max-h-80 flex-col overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-lg ${
            searchable ? "w-80" : "w-64"
          }`}
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-zinc-800 px-3 py-2">
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

          {searchable && options.length > 0 ? (
            <FilterSearchInput
              inputRef={searchRef}
              query={query}
              placeholder={searchPlaceholder}
              onQueryChange={setQuery}
              onEscape={close}
            />
          ) : null}

          <FilterOptionsList
            listId={listId}
            legendLabel={legendLabel ?? `Filter by ${label.toLowerCase()}`}
            options={options.length === 0 ? [] : visibleOptions}
            selectedSet={selectedSet}
            maxLabelLength={maxLabelLength}
            emptyLabel={options.length === 0 ? emptyLabel : "No matches"}
            onToggle={toggleValue}
          />
        </div>
      ) : null}
    </div>
  );
}
