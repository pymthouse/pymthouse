"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

import {
  BILLING_CYCLE_PARAM,
  billingCycleSelectOptions,
  formatBillingCycleMonthLabel,
  resolveBillingCycle,
} from "@/lib/billing-utils";

/**
 * UTC month selector persisted in `?cycle=YYYY-MM`.
 * The current month omits the query param so existing bookmarks stay current.
 */
export default function BillingCyclePicker({
  className,
}: Readonly<{ className?: string }>) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const selected = resolveBillingCycle(searchParams.get(BILLING_CYCLE_PARAM));
  const options = billingCycleSelectOptions({ selectedKey: selected.key });
  const selectedIndex = options.findIndex((option) => option.key === selected.key);
  const newer = selectedIndex > 0 ? options[selectedIndex - 1] : null;
  const older =
    selectedIndex >= 0 && selectedIndex < options.length - 1
      ? options[selectedIndex + 1]
      : null;

  function navigateTo(key: string) {
    const params = new URLSearchParams(searchParams.toString());
    const next = resolveBillingCycle(key);
    if (next.isCurrent) {
      params.delete(BILLING_CYCLE_PARAM);
    } else {
      params.set(BILLING_CYCLE_PARAM, next.key);
    }
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className ?? ""}`}>
      <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
        Cycle
      </span>
      <button
        type="button"
        disabled={!older}
        onClick={() => older && navigateTo(older.key)}
        aria-label="Previous billing cycle"
        className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs text-zinc-300 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-30"
      >
        ←
      </button>
      <label className="sr-only" htmlFor="billing-cycle-select">
        Billing cycle
      </label>
      <select
        id="billing-cycle-select"
        value={selected.key}
        onChange={(event) => navigateTo(event.target.value)}
        className="max-w-[11rem] rounded-md border border-white/10 bg-black/40 px-2 py-1 text-xs font-medium text-zinc-100"
      >
        {options.map((option) => (
          <option key={option.key} value={option.key}>
            {option.isCurrent ? `${option.label} (current)` : option.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={!newer}
        onClick={() => newer && navigateTo(newer.key)}
        aria-label="Next billing cycle"
        className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs text-zinc-300 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-30"
      >
        →
      </button>
      {selected.isCurrent ? null : (
        <span className="text-[11px] text-zinc-500">
          {formatBillingCycleMonthLabel(selected.key)}
        </span>
      )}
    </div>
  );
}
