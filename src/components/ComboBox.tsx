"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

export interface ComboBoxOption {
  value: string;
  label: string;
}

export interface ComboBoxProps {
  options: ComboBoxOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  emptyLabel?: string;
}

export default function ComboBox({
  options,
  value,
  onChange,
  placeholder = "Search…",
  disabled = false,
  emptyLabel = "— none —",
}: ComboBoxProps) {
  const listId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [highlightIndex, setHighlightIndex] = useState(0);

  const noneOption: ComboBoxOption = { value: "", label: emptyLabel };
  const allOptions = [noneOption, ...options];

  const selectedLabel =
    value === "" ? null : options.find((o) => o.value === value)?.label ?? value;

  const q = filter.trim().toLowerCase();
  const filteredOptions = allOptions.filter((o) => {
    if (!q) return true;
    return o.label.toLowerCase().includes(q);
  });

  const safeHighlightIndex =
    filteredOptions.length === 0
      ? 0
      : Math.min(highlightIndex, filteredOptions.length - 1);

  const close = useCallback(() => {
    setOpen(false);
    setFilter("");
    setHighlightIndex(0);
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

  const selectOption = (next: string) => {
    onChange(next);
    close();
    inputRef.current?.blur();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filteredOptions.length === 0) return;
      if (!open) {
        setOpen(true);
        setHighlightIndex(0);
        return;
      }
      setHighlightIndex((i) => Math.min(i + 1, filteredOptions.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filteredOptions.length === 0) return;
      if (!open) {
        setOpen(true);
        setHighlightIndex(filteredOptions.length - 1);
        return;
      }
      setHighlightIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        setHighlightIndex(0);
        return;
      }
      const pick = filteredOptions[safeHighlightIndex] ?? filteredOptions[0];
      if (pick) selectOption(pick.value);
      return;
    }
  };

  return (
    <div ref={containerRef} className="relative w-full">
      {selectedLabel && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          <span className="inline-flex items-center gap-1 max-w-full rounded-full bg-zinc-700 px-2 py-0.5 text-xs text-zinc-100">
            <span className="truncate">{selectedLabel}</span>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange("")}
              className="shrink-0 rounded p-0.5 text-zinc-400 hover:bg-zinc-600 hover:text-zinc-100 disabled:opacity-40"
              aria-label="Clear selection"
            >
              ×
            </button>
          </span>
        </div>
      )}
      <input
        ref={inputRef}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        value={open ? filter : ""}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => {
          setFilter(e.target.value);
          setHighlightIndex(0);
          if (!open) setOpen(true);
        }}
        onFocus={() => {
          if (disabled) return;
          setOpen(true);
          setFilter("");
          setHighlightIndex(0);
        }}
        onKeyDown={onKeyDown}
        className="w-full px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-sm text-zinc-100 placeholder:text-zinc-500 disabled:opacity-50"
      />
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-50 mt-1 max-h-48 w-full overflow-auto rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-lg"
        >
          {filteredOptions.length === 0 ? (
            <li className="px-3 py-2 text-sm text-zinc-500">No matches</li>
          ) : (
            filteredOptions.map((opt, idx) => (
              <li key={opt.value === "" ? "__none__" : opt.value} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={value === opt.value}
                  className={`w-full px-3 py-2 text-left text-sm ${
                    idx === safeHighlightIndex
                      ? "bg-zinc-700 text-zinc-100"
                      : "text-zinc-200 hover:bg-zinc-800"
                  } ${opt.value === "" ? "text-zinc-500" : ""}`}
                  onMouseEnter={() => setHighlightIndex(idx)}
                  onClick={() => selectOption(opt.value)}
                >
                  {opt.label}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
