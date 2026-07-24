"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

export interface MultiComboBoxOption {
  value: string;
  label: string;
  /** Groups options under a header in the dropdown */
  group?: string;
}

export interface MultiComboBoxProps {
  options: MultiComboBoxOption[];
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Custom label for chips. Defaults to option.label */
  chipLabel?: (value: string, option: MultiComboBoxOption | undefined) => string;
}

export default function MultiComboBox({
  options,
  values,
  onChange,
  placeholder = "Search…",
  disabled = false,
  chipLabel,
}: Readonly<MultiComboBoxProps>) {
  const listId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [highlightIndex, setHighlightIndex] = useState(0);

  const q = filter.trim().toLowerCase();
  const filteredOptions = options.filter((o) => {
    if (!q) return true;
    return (
      o.label.toLowerCase().includes(q) ||
      (o.group?.toLowerCase().includes(q) ?? false)
    );
  });

  const safeHighlightIndex = Math.min(
    highlightIndex,
    Math.max(0, filteredOptions.length - 1),
  );

  const close = useCallback(() => {
    setOpen(false);
    setFilter("");
    setHighlightIndex(0);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        close();
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, close]);

  const toggleOption = (value: string) => {
    if (values.includes(value)) {
      onChange(values.filter((v) => v !== value));
    } else {
      onChange([...values, value]);
    }
  };

  const removeValue = (value: string) => {
    onChange(values.filter((v) => v !== value));
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
      const pick = filteredOptions[safeHighlightIndex];
      if (pick) toggleOption(pick.value);
      return;
    }
  };

  // Group filtered options preserving original order
  const grouped: { group: string | null; items: MultiComboBoxOption[] }[] = [];
  for (const opt of filteredOptions) {
    const g = opt.group ?? null;
    const existing = grouped.find((gr) => gr.group === g);
    if (existing) {
      existing.items.push(opt);
    } else {
      grouped.push({ group: g, items: [opt] });
    }
  }

  return (
    <div ref={containerRef} className="relative w-full">
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {values.map((v) => {
            const opt = options.find((o) => o.value === v);
            const label = chipLabel ? chipLabel(v, opt) : (opt?.label ?? v);
            return (
              <span
                key={v}
                className="inline-flex items-center gap-1 max-w-full rounded-full bg-zinc-700 px-2 py-0.5 text-xs text-zinc-100"
              >
                <span className="truncate">{label}</span>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => removeValue(v)}
                  className="shrink-0 rounded p-0.5 text-zinc-400 hover:bg-zinc-600 hover:text-zinc-100 disabled:opacity-40"
                  aria-label={`Remove ${label}`}
                >
                  ×
                </button>
              </span>
            );
          })}
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
          aria-multiselectable="true"
          className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-lg"
        >
          {filteredOptions.length === 0 ? (
            <li className="px-3 py-2 text-sm text-zinc-500">No matches</li>
          ) : (
            grouped.map((gr) => (
              <li key={gr.group ?? "__ungrouped__"} role="presentation">
                {gr.group && (
                  <div className="px-3 pt-2 pb-0.5 text-[10px] font-semibold text-zinc-500 uppercase tracking-widest select-none">
                    {gr.group}
                  </div>
                )}
                <ul role="presentation">
                  {gr.items.map((opt) => {
                    const flatIdx = filteredOptions.indexOf(opt);
                    const selected = values.includes(opt.value);
                    return (
                      <li key={opt.value} role="presentation">
                        <button
                          type="button"
                          role="option"
                          aria-selected={selected}
                          className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm ${
                            flatIdx === safeHighlightIndex
                              ? "bg-zinc-700 text-zinc-100"
                              : "text-zinc-200 hover:bg-zinc-800"
                          }`}
                          onMouseEnter={() => setHighlightIndex(flatIdx)}
                          onClick={() => toggleOption(opt.value)}
                        >
                          <span
                            className={`flex-shrink-0 w-3.5 h-3.5 rounded border flex items-center justify-center text-[9px] font-bold ${
                              selected
                                ? "bg-emerald-600 border-emerald-600 text-white"
                                : "border-zinc-600"
                            }`}
                          >
                            {selected && "✓"}
                          </span>
                          <span>{opt.label}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
