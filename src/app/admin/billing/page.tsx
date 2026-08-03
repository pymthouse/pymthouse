"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import DashboardLayout from "@/components/DashboardLayout";
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

export default function AdminPlatformBillingPage() {
  const router = useRouter();
  const { data: session, status } = useSession();
  const userRole = (session?.user as Record<string, unknown> | undefined)?.role as
    | string
    | undefined;

  const [platform, setPlatform] = useState<PlatformResponse | null>(null);
  const [defaultDisplay, setDefaultDisplay] = useState("5.00");
  const [savingPlatform, setSavingPlatform] = useState(false);
  const [migrate, setMigrate] = useState<MigrateStats | null>(null);

  const [query, setQuery] = useState("");
  const [owners, setOwners] = useState<OwnerSummary[]>([]);
  const [loadingOwners, setLoadingOwners] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [starterDisplay, setStarterDisplay] = useState("");
  const [endUserCap, setEndUserCap] = useState("");
  const [applicationFeeBps, setApplicationFeeBps] = useState("");
  const [note, setNote] = useState("");
  const [savingOwner, setSavingOwner] = useState(false);

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

  const loadOwners = useCallback(async (q: string) => {
    setLoadingOwners(true);
    try {
      const res = await fetch(
        `/api/v1/admin/billing/owners?q=${encodeURIComponent(q)}`,
      );
      if (!res.ok) {
        throw new Error(`Failed to search owners (${res.status})`);
      }
      const data = await res.json();
      setOwners(data.owners ?? []);
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
        await loadOwners("");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [status, userRole, router, loadPlatform, loadOwners]);

  function selectOwner(owner: OwnerSummary) {
    setSelectedId(owner.id);
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
    setMessage(null);
    setError(null);
  }

  async function savePlatformDefault() {
    setSavingPlatform(true);
    setError(null);
    setMessage(null);
    setMigrate(null);
    try {
      const micros = usdCentsDisplayToMicros(defaultDisplay);
      if (!micros) {
        setError("Enter a valid USD amount for the platform default (e.g. 5.00)");
        return;
      }
      const res = await fetch("/api/v1/admin/billing/platform", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerStarterIncludedUsdMicros: micros }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to update platform default");
      }
      setPlatform({
        ownerStarterIncludedUsdMicros: data.ownerStarterIncludedUsdMicros,
        source: data.source,
        updatedBy: null,
        updatedAt: new Date().toISOString(),
        planKey: data.planKey,
      });
      setDefaultDisplay(usdMicrosToCentsDisplay(data.ownerStarterIncludedUsdMicros));
      setMigrate(data.migrate ?? null);
      setMessage(
        `Platform default saved. Base plan ${data.planKey} republished` +
          (data.migrate
            ? ` — migrated ${data.migrate.updated}, skipped ${data.migrate.skipped}, errors ${data.migrate.errors}.`
            : "."),
      );
      await loadOwners(query);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingPlatform(false);
    }
  }

  async function saveOwnerOverrides(clearStarter = false) {
    if (!selectedId) return;
    setSavingOwner(true);
    setError(null);
    setMessage(null);
    try {
      const body: Record<string, unknown> = {};

      if (clearStarter) {
        body.starterIncludedUsdMicros = null;
      } else if (starterDisplay.trim()) {
        const micros = usdCentsDisplayToMicros(starterDisplay);
        if (!micros) {
          setError("Enter a valid USD starter allowance or clear the field");
          return;
        }
        body.starterIncludedUsdMicros = micros;
      } else {
        body.starterIncludedUsdMicros = null;
      }

      if (endUserCap.trim()) {
        const parsed = Number.parseInt(endUserCap, 10);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          setError("End-user cap must be a positive integer");
          return;
        }
        body.endUserCap = parsed;
      } else {
        body.endUserCap = null;
      }

      if (applicationFeeBps.trim()) {
        const parsed = Number.parseInt(applicationFeeBps, 10);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10_000) {
          setError("Application fee must be an integer from 0 to 10000");
          return;
        }
        body.applicationFeeBps = parsed;
      } else {
        body.applicationFeeBps = null;
      }

      body.note = note.trim() || null;

      const res = await fetch(`/api/v1/admin/billing/owners/${selectedId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to update owner billing");
      }
      setMessage(
        `Saved overrides for ${data.owner?.email ?? selectedId}` +
          (data.planKey ? ` (plan ${data.planKey})` : ""),
      );
      await loadOwners(query);
      if (data.resolved) {
        setStarterDisplay(
          data.overrides?.starterIncludedUsdMicros
            ? usdMicrosToCentsDisplay(data.overrides.starterIncludedUsdMicros)
            : "",
        );
        setEndUserCap(
          data.overrides?.endUserCap != null ? String(data.overrides.endUserCap) : "",
        );
        setApplicationFeeBps(
          data.overrides?.applicationFeeBps != null
            ? String(data.overrides.applicationFeeBps)
            : "",
        );
        setNote(data.overrides?.note ?? "");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingOwner(false);
    }
  }

  if (status === "loading" || (status === "authenticated" && userRole !== "admin")) {
    return (
      <DashboardLayout>
        <div className="text-zinc-500 text-center py-12 animate-pulse">
          Loading…
        </div>
      </DashboardLayout>
    );
  }

  const selected = owners.find((o) => o.id === selectedId) ?? null;

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
            Applies to new developer accounts and re-syncs everyone still on the shared
            base plan <code className="text-zinc-300">{platform?.planKey ?? "pymthouse_owner_starter"}</code>.
            Per-owner amount overrides are not moved.
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
              {savingPlatform ? "Saving & re-syncing…" : "Save & re-sync base plan"}
            </button>
          </div>
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
          <div className="flex flex-wrap gap-2">
            <input
              type="search"
              placeholder="Search by email, name, or user id"
              className="min-w-[16rem] flex-1 rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm text-zinc-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500/40"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void loadOwners(query);
                }
              }}
            />
            <button
              type="button"
              className="rounded-md border border-white/10 px-3 py-2 text-sm text-zinc-200 hover:border-emerald-500/40"
              disabled={loadingOwners}
              onClick={() => void loadOwners(query)}
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
                <button
                  type="button"
                  className={`w-full px-3 py-3 text-left text-sm transition-colors hover:bg-white/5 ${
                    selectedId === owner.id ? "bg-emerald-500/10" : ""
                  }`}
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
                  <div className="mt-1 text-xs text-zinc-500">
                    {owner.id}
                    {owner.resolved.note ? ` · ${owner.resolved.note}` : ""}
                  </div>
                </button>
              </li>
            ))}
          </ul>

          {selected && (
            <div className="space-y-3 border-t border-white/10 pt-4">
              <h3 className="text-sm font-medium text-zinc-200">
                Overrides for {selected.email ?? selected.id}
              </h3>
              <p className="text-xs text-zinc-500">
                Empty fields clear back to the platform default. Effective now: $
                {usdMicrosToCentsDisplay(selected.resolved.starterIncludedUsdMicros)}{" "}
                included · cap {selected.resolved.endUserCap} · fee{" "}
                {selected.resolved.applicationFeeBps} bps
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-sm">
                  <span className="text-zinc-400">Starter allowance (USD)</span>
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
                  <span className="text-zinc-400">End-user cap</span>
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
                  <span className="text-zinc-400">Application fee (bps)</span>
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
          )}
        </section>
      </div>
    </DashboardLayout>
  );
}
