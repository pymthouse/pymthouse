"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import DashboardLayout from "@/components/DashboardLayout";
import InfoTooltip from "@/components/InfoTooltip";
import { buildOwnerOverridePatchBody } from "@/lib/billing/owner-override-form";
import {
  sanitizeUsdCentsInput,
  usdCentsDisplayToMicros,
  usdMicrosToCentsDisplay,
} from "@/lib/format-usd-micros";

type PlatformResponse = {
  ownerStarterIncludedUsdMicros: string;
  source: "db" | "env" | "fallback";
  updatedBy: string | null;
  updatedAt: string | null;
  planKey: string;
};

type MigrateStats = {
  updated: number;
  skipped: number;
  errors: number;
};

type OwnerSummary = {
  id: string;
  email: string | null;
  name: string | null;
  role: string;
  resolved: {
    starterIncludedUsdMicros: string;
    endUserCap: number;
    applicationFeeBps: number;
    hasOverride: boolean;
    note: string | null;
  };
  overrides: {
    starterIncludedUsdMicros: string | null;
    endUserCap: number | null;
    applicationFeeBps: number | null;
    note: string | null;
  } | null;
};

const PAGE_SIZE = 25;

export default function AdminPlatformBillingPage() {
  const router = useRouter();
  const { data: session, status } = useSession();
  const userRole = (session?.user as Record<string, unknown> | undefined)?.role as
    | string
    | undefined;

  const [platform, setPlatform] = useState<PlatformResponse | null>(null);
  const [defaultDisplay, setDefaultDisplay] = useState("5.00");
  const [savingPlatform, setSavingPlatform] = useState(false);
  const [resyncSubscribers, setResyncSubscribers] = useState(false);
  const [migrate, setMigrate] = useState<MigrateStats | null>(null);
  const [platformStatus, setPlatformStatus] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [owners, setOwners] = useState<OwnerSummary[]>([]);
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [loadingOwners, setLoadingOwners] = useState(false);
  const [selected, setSelected] = useState<OwnerSummary | null>(null);
  const [starterDisplay, setStarterDisplay] = useState("");
  const [endUserCap, setEndUserCap] = useState("");
  const [applicationFeeBps, setApplicationFeeBps] = useState("");
  const [note, setNote] = useState("");
  const [savingOwner, setSavingOwner] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const loadPlatform = useCallback(async () => {
    const res = await fetch("/api/v1/admin/billing/platform");
    if (!res.ok) {
      throw new Error(`Failed to load platform billing (${res.status})`);
    }
    const data = (await res.json()) as PlatformResponse;
    setPlatform(data);
    setDefaultDisplay(usdMicrosToCentsDisplay(data.ownerStarterIncludedUsdMicros));
  }, []);

  const loadOwners = useCallback(async (q: string, pageNum: number) => {
    setLoadingOwners(true);
    try {
      const params = new URLSearchParams({
        q,
        page: String(pageNum),
        pageSize: String(PAGE_SIZE),
      });
      const res = await fetch(`/api/v1/admin/billing/owners?${params}`);
      if (!res.ok) {
        throw new Error(`Failed to search owners (${res.status})`);
      }
      const data = await res.json();
      setOwners(data.owners ?? []);
      setPage(typeof data.page === "number" ? data.page : pageNum);
      setTotalCount(typeof data.totalCount === "number" ? data.totalCount : 0);
    } finally {
      setLoadingOwners(false);
    }
  }, []);

  useEffect(() => {
    if (status === "unauthenticated" || (status === "authenticated" && userRole !== "admin")) {
      router.push("/");
      return;
    }
    if (status !== "authenticated") return;

    void (async () => {
      try {
        await loadPlatform();
        await loadOwners("", 1);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [status, userRole, router, loadPlatform, loadOwners]);

  function fillOverrideForm(owner: OwnerSummary) {
    setStarterDisplay(
      owner.overrides?.starterIncludedUsdMicros
        ? usdMicrosToCentsDisplay(owner.overrides.starterIncludedUsdMicros)
        : "",
    );
    setEndUserCap(
      owner.overrides?.endUserCap != null ? String(owner.overrides.endUserCap) : "",
    );
    setApplicationFeeBps(
      owner.overrides?.applicationFeeBps != null
        ? String(owner.overrides.applicationFeeBps)
        : "",
    );
    setNote(owner.overrides?.note ?? "");
  }

  function selectOwner(owner: OwnerSummary) {
    setSelected(owner);
    fillOverrideForm(owner);
    setMessage(null);
    setError(null);
  }

  async function copyOwnerId(id: string) {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      setError("Clipboard is not available in this browser");
      return;
    }
    try {
      await navigator.clipboard.writeText(id);
      setCopiedId(id);
      window.setTimeout(() => {
        setCopiedId((current) => (current === id ? null : current));
      }, 1500);
    } catch {
      setError("Failed to copy user id");
    }
  }

  async function savePlatformDefault() {
    setSavingPlatform(true);
    setError(null);
    setMessage(null);
    setPlatformStatus(null);
    setMigrate(null);
    try {
      const micros = usdCentsDisplayToMicros(defaultDisplay);
      if (!micros) {
        setError("Enter a valid USD amount for the platform default (e.g. 5.00)");
        setPlatformStatus("Enter a valid USD amount (e.g. 5.00)");
        return;
      }
      const res = await fetch("/api/v1/admin/billing/platform", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownerStarterIncludedUsdMicros: micros,
          resync: resyncSubscribers,
        }),
      });
      let data: {
        error?: string;
        ownerStarterIncludedUsdMicros?: string;
        source?: "db" | "env" | "fallback";
        planKey?: string;
        resyncSubscribers?: boolean;
        migrate?: MigrateStats | null;
      };
      try {
        data = await res.json();
      } catch {
        throw new Error(
          res.ok
            ? "Save succeeded but the response could not be read"
            : `Failed to update platform default (${res.status})`,
        );
      }
      if (!res.ok) {
        throw new Error(data.error || "Failed to update platform default");
      }
      if (!data.ownerStarterIncludedUsdMicros || !data.planKey) {
        throw new Error("Save response was missing plan details");
      }
      setPlatform({
        ownerStarterIncludedUsdMicros: data.ownerStarterIncludedUsdMicros,
        source: data.source ?? "db",
        updatedBy: null,
        updatedAt: new Date().toISOString(),
        planKey: data.planKey,
      });
      setDefaultDisplay(usdMicrosToCentsDisplay(data.ownerStarterIncludedUsdMicros));
      const migrateStats = data.migrate ?? null;
      setMigrate(migrateStats);

      const statusParts = [
        `Saved ${usdMicrosToCentsDisplay(data.ownerStarterIncludedUsdMicros)} USD`,
        `plan ${data.planKey} republished`,
      ];
      if (data.resyncSubscribers && migrateStats) {
        statusParts.push(
          `re-synced subscribers (updated ${migrateStats.updated}, skipped ${migrateStats.skipped}, errors ${migrateStats.errors})`,
        );
      } else {
        statusParts.push("subscriber re-sync skipped");
      }
      const status = statusParts.join(" · ");
      setPlatformStatus(status);
      setMessage(status);
      try {
        await loadOwners(query, page);
      } catch (reloadErr) {
        console.error("Failed to refresh owners after platform save", reloadErr);
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      setError(text);
      setPlatformStatus(text);
    } finally {
      setSavingPlatform(false);
    }
  }

  async function saveOwnerOverrides(clearStarter = false) {
    if (!selected) return;
    setSavingOwner(true);
    setError(null);
    setMessage(null);
    try {
      const built = buildOwnerOverridePatchBody({
        starterDisplay,
        endUserCap,
        applicationFeeBps,
        note,
        clearStarter,
      });
      if (!built.ok) {
        setError(built.error);
        return;
      }

      const res = await fetch(`/api/v1/admin/billing/owners/${selected.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(built.body),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to update owner billing");
      }
      setMessage(
        `Saved overrides for ${data.owner?.email ?? selected.id}` +
          (data.planKey ? ` (plan ${data.planKey})` : ""),
      );
      await loadOwners(query, page);
      if (data.resolved) {
        const next: OwnerSummary = {
          id: data.owner?.id ?? selected.id,
          email: data.owner?.email ?? selected.email,
          name: data.owner?.name ?? selected.name,
          role: data.owner?.role ?? selected.role,
          resolved: data.resolved,
          overrides: data.overrides ?? null,
        };
        setSelected(next);
        fillOverrideForm(next);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingOwner(false);
    }
  }

  function searchOwners() {
    setPage(1);
    void loadOwners(query, 1);
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const rangeStart = totalCount === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(page * PAGE_SIZE, totalCount);

  if (status === "loading" || (status === "authenticated" && userRole !== "admin")) {
    return (
      <DashboardLayout>
        <div className="text-zinc-500 text-center py-12 animate-pulse">
          Loading…
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="max-w-4xl mx-auto space-y-10 py-6">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-100">Platform Billing</h1>
          <p className="mt-2 text-sm text-zinc-400">
            Configure the Owner Starter cost-rail default for developer accounts and
            per-owner overrides. App / M2M retail plans stay under each app&apos;s Plans
            tab.
          </p>
        </div>

        {error && (
          <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}
        {message && (
          <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">
            {message}
          </div>
        )}

        <section className="space-y-4 rounded-lg border border-white/10 bg-black/20 p-5">
          <h2 className="text-lg font-medium text-zinc-100">
            Owner Starter platform default
          </h2>
          <p className="text-sm text-zinc-500">
            Applies to new developer accounts. Saving always updates the stored default
            and republishes base plan{" "}
            <code className="text-zinc-300">{platform?.planKey ?? "pymthouse_owner_starter"}</code>.
            Optionally re-sync existing subscribers still on that shared base plan
            (per-owner amount overrides are not moved).
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="block text-sm">
              <span className="text-zinc-400">Included allowance (USD)</span>
              <input
                type="text"
                inputMode="decimal"
                className="mt-1 block w-40 rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm text-zinc-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500/40"
                value={defaultDisplay}
                onChange={(e) => setDefaultDisplay(sanitizeUsdCentsInput(e.target.value))}
                disabled={savingPlatform}
              />
            </label>
            <button
              type="button"
              className="rounded-md bg-emerald-500/20 px-4 py-2 text-sm text-emerald-300 disabled:opacity-50"
              disabled={savingPlatform}
              onClick={() => void savePlatformDefault()}
            >
              {savingPlatform
                ? resyncSubscribers
                  ? "Saving & re-syncing…"
                  : "Saving…"
                : resyncSubscribers
                  ? "Save & re-sync base plan"
                  : "Save platform default"}
            </button>
          </div>
          <label className="flex items-start gap-2 text-sm text-zinc-400">
            <input
              type="checkbox"
              className="mt-1"
              checked={resyncSubscribers}
              disabled={savingPlatform}
              onChange={(e) => setResyncSubscribers(e.target.checked)}
            />
            <span>
              Also re-sync subscribers still on the shared base plan. Leave unchecked to
              only save the default for new accounts / future ensures.
            </span>
          </label>
          {platformStatus && (
            <div
              role="status"
              aria-live="polite"
              className={`rounded-md border px-3 py-2 text-sm ${
                error && platformStatus === error
                  ? "border-red-500/40 bg-red-500/10 text-red-300"
                  : "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
              }`}
            >
              {platformStatus}
            </div>
          )}
          {platform && (
            <p className="text-xs text-zinc-500">
              Current source: <span className="text-zinc-300">{platform.source}</span>
              {platform.updatedAt ? ` · updated ${platform.updatedAt}` : ""}
              {" · "}
              {usdMicrosToCentsDisplay(platform.ownerStarterIncludedUsdMicros)} USD
            </p>
          )}
          {migrate && (
            <p className="text-xs text-zinc-400">
              Last migrate: updated {migrate.updated}, skipped {migrate.skipped}, errors{" "}
              {migrate.errors}
            </p>
          )}
        </section>

        <section className="space-y-4 rounded-lg border border-white/10 bg-black/20 p-5">
          <h2 className="text-lg font-medium text-zinc-100">Developer accounts</h2>

          {selected ? (
            <div className="space-y-3 rounded-md border border-emerald-500/20 bg-emerald-500/5 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 className="text-sm font-medium text-zinc-200">
                    Overrides for {selected.email ?? selected.name ?? selected.id}
                  </h3>
                  <button
                    type="button"
                    className="mt-1 font-mono text-xs text-zinc-400 hover:text-emerald-300"
                    title="Copy user id"
                    onClick={() => void copyOwnerId(selected.id)}
                  >
                    {selected.id}
                    {copiedId === selected.id ? " · copied" : " · copy"}
                  </button>
                </div>
                <button
                  type="button"
                  className="text-xs text-zinc-500 hover:text-zinc-300"
                  onClick={() => setSelected(null)}
                >
                  Clear selection
                </button>
              </div>
              <p className="text-xs text-zinc-500">
                Empty fields clear back to the platform default. Effective now: $
                {usdMicrosToCentsDisplay(selected.resolved.starterIncludedUsdMicros)}{" "}
                included · cap {selected.resolved.endUserCap} · fee{" "}
                {selected.resolved.applicationFeeBps} bps
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-sm">
                  <span className="inline-flex items-center gap-1.5 text-zinc-400">
                    Starter allowance (USD)
                    <InfoTooltip
                      wide
                      label="USD credit on this developer's Owner Starter plan. Network usage burns this credit first; after it runs out they pay for overage."
                    />
                  </span>
                  <input
                    type="text"
                    inputMode="decimal"
                    className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm"
                    value={starterDisplay}
                    onChange={(e) =>
                      setStarterDisplay(sanitizeUsdCentsInput(e.target.value))
                    }
                    placeholder="platform default"
                    disabled={savingOwner}
                  />
                </label>
                <label className="block text-sm">
                  <span className="inline-flex items-center gap-1.5 text-zinc-400">
                    End-user cap
                    <InfoTooltip
                      wide
                      label="Maximum number of end users this developer can provision across their apps. Not money — a headcount limit."
                    />
                  </span>
                  <input
                    type="number"
                    min={1}
                    className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm"
                    value={endUserCap}
                    onChange={(e) => setEndUserCap(e.target.value)}
                    placeholder="platform default"
                    disabled={savingOwner}
                  />
                </label>
                <label className="block text-sm">
                  <span className="inline-flex items-center gap-1.5 text-zinc-400">
                    Application fee (bps)
                    <InfoTooltip
                      wide
                      label="Platform take rate on merchant (Stripe Connect) charges, in basis points. 100 bps = 1%. 0 means no platform fee."
                    />
                  </span>
                  <input
                    type="number"
                    min={0}
                    max={10000}
                    className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm"
                    value={applicationFeeBps}
                    onChange={(e) => setApplicationFeeBps(e.target.value)}
                    placeholder="platform default"
                    disabled={savingOwner}
                  />
                </label>
                <label className="block text-sm sm:col-span-2">
                  <span className="text-zinc-400">Note</span>
                  <input
                    type="text"
                    className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    disabled={savingOwner}
                  />
                </label>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="rounded-md bg-emerald-500/20 px-4 py-2 text-sm text-emerald-300 disabled:opacity-50"
                  disabled={savingOwner}
                  onClick={() => void saveOwnerOverrides(false)}
                >
                  {savingOwner ? "Saving…" : "Save overrides"}
                </button>
                <button
                  type="button"
                  className="rounded-md border border-white/10 px-4 py-2 text-sm text-zinc-300 disabled:opacity-50"
                  disabled={savingOwner}
                  onClick={() => {
                    setStarterDisplay("");
                    void saveOwnerOverrides(true);
                  }}
                >
                  Clear starter to default
                </button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-zinc-500">
              Select a developer account below to edit per-owner overrides.
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <input
              type="search"
              placeholder="Search by email, name, or user id"
              className="min-w-[16rem] flex-1 rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm text-zinc-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500/40"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  searchOwners();
                }
              }}
            />
            <button
              type="button"
              className="rounded-md border border-white/10 px-3 py-2 text-sm text-zinc-200 hover:border-emerald-500/40"
              disabled={loadingOwners}
              onClick={searchOwners}
            >
              {loadingOwners ? "Searching…" : "Search"}
            </button>
          </div>

          <ul className="divide-y divide-white/5 rounded-md border border-white/10">
            {owners.length === 0 && (
              <li className="px-3 py-4 text-sm text-zinc-500">No matching accounts</li>
            )}
            {owners.map((owner) => (
              <li key={owner.id}>
                <div
                  className={`flex items-start gap-2 px-3 py-3 text-sm transition-colors ${
                    selected?.id === owner.id ? "bg-emerald-500/10" : "hover:bg-white/5"
                  }`}
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => selectOwner(owner)}
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-zinc-100">
                        {owner.email ?? owner.name ?? owner.id}
                      </span>
                      <span className="text-xs text-zinc-500">
                        {owner.resolved.hasOverride ? "override" : "default"} · $
                        {usdMicrosToCentsDisplay(owner.resolved.starterIncludedUsdMicros)}
                      </span>
                    </div>
                    {owner.resolved.note ? (
                      <div className="mt-1 text-xs text-zinc-500">{owner.resolved.note}</div>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    className="shrink-0 rounded border border-white/10 px-2 py-1 font-mono text-[11px] text-zinc-400 hover:border-emerald-500/40 hover:text-emerald-300"
                    title={`Copy user id ${owner.id}`}
                    onClick={() => void copyOwnerId(owner.id)}
                  >
                    {copiedId === owner.id ? "Copied" : `${owner.id.slice(0, 8)}…`}
                  </button>
                </div>
              </li>
            ))}
          </ul>

          <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-zinc-500">
            <span>
              {totalCount === 0
                ? "0 accounts"
                : `${rangeStart}–${rangeEnd} of ${totalCount}`}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="rounded-md border border-white/10 px-3 py-1.5 text-zinc-200 disabled:opacity-40"
                disabled={loadingOwners || page <= 1}
                onClick={() => {
                  const next = page - 1;
                  setPage(next);
                  void loadOwners(query, next);
                }}
              >
                Previous
              </button>
              <span className="text-zinc-400">
                Page {page} / {totalPages}
              </span>
              <button
                type="button"
                className="rounded-md border border-white/10 px-3 py-1.5 text-zinc-200 disabled:opacity-40"
                disabled={loadingOwners || page >= totalPages}
                onClick={() => {
                  const next = page + 1;
                  setPage(next);
                  void loadOwners(query, next);
                }}
              >
                Next
              </button>
            </div>
          </div>
        </section>
      </div>
    </DashboardLayout>
  );
}
