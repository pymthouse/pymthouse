"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import DashboardLayout from "@/components/DashboardLayout";

interface AdminApp {
  id: string;
  name: string;
  subtitle: string | null;
  category: string | null;
  status: string;
  developerName: string | null;
  createdAt: string;
  publishedAt: string | null;
  ownerId: string | null;
  ownerEmail: string | null;
  ownerName: string | null;
  clientId: string | null;
  marketplaceFeatured?: number | null;
}

export default function AdminAppsPage() {
  const router = useRouter();
  const { data: session, status } = useSession();
  const [apps, setApps] = useState<AdminApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [featuring, setFeaturing] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [ownerDrafts, setOwnerDrafts] = useState<Record<string, string>>({});
  const [adminDrafts, setAdminDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const userRole = (session?.user as Record<string, unknown> | undefined)?.role as string | undefined;

  useEffect(() => {
    if (status === "unauthenticated" || (status === "authenticated" && userRole !== "admin")) {
      router.push("/");
      setLoading(false);
      return;
    }
    if (status !== "authenticated") return;

    fetch("/api/v1/admin/apps")
      .then((r) => r.json())
      .then((data) => setApps(data.apps || []))
      .catch(() => setApps([]))
      .finally(() => setLoading(false));
  }, [status, userRole, router]);

  const handleToggleFeatured = async (appId: string, featured: boolean) => {
    setFeaturing(appId);
    setError(null);
    try {
      const res = await fetch(`/api/v1/admin/apps/${appId}/marketplace-featured`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ featured }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to update featured state");
        return;
      }
      setApps((prev) =>
        prev.map((a) =>
          a.id === appId
            ? { ...a, marketplaceFeatured: data.featured ? 1 : 0 }
            : a,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setFeaturing(null);
    }
  };

  const handleReassignOwner = async (app: AdminApp) => {
    const newOwnerUserId = (ownerDrafts[app.id] ?? "").trim();
    if (!newOwnerUserId) return;
    setActing(app.id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/v1/admin/apps/${encodeURIComponent(app.id)}/owner`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newOwnerUserId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to reassign owner");
        return;
      }
      setApps((prev) =>
        prev.map((row) =>
          row.id === app.id ? { ...row, ownerId: data.ownerId } : row,
        ),
      );
      setNotice(`Reassigned ${app.name} to ${newOwnerUserId}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setActing(null);
    }
  };

  const handleGrantCoAdmin = async (app: AdminApp) => {
    const userId = (adminDrafts[app.id] ?? "").trim();
    const clientId = app.clientId || app.id;
    if (!userId) return;
    setActing(app.id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/v1/apps/${encodeURIComponent(clientId)}/admins`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to grant co-admin");
        return;
      }
      setNotice(`Granted co-admin on ${app.name} to ${userId}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setActing(null);
    }
  };

  if (status === "loading" || (status === "authenticated" && userRole !== "admin")) {
    return (
      <DashboardLayout>
        <div className="text-zinc-500 text-center py-12 animate-pulse">
          Loading...
        </div>
      </DashboardLayout>
    );
  }

  const liveApps = apps.filter((a) => a.status === "approved");

  return (
    <DashboardLayout>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-zinc-100">Marketplace Apps</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Curate which live apps appear on the homepage featured strip
        </p>
      </div>

      {error && (
        <div className="mb-6 p-4 rounded-lg border border-red-500/20 bg-red-500/5 text-red-300 text-sm">
          {error}
        </div>
      )}
      {notice && (
        <div className="mb-6 p-4 rounded-lg border border-emerald-500/20 bg-emerald-500/5 text-emerald-300 text-sm">
          {notice}
        </div>
      )}

      {loading && (
        <div className="text-zinc-500 text-center py-12 animate-pulse">
          Loading apps...
        </div>
      )}

      {!loading && liveApps.length === 0 && (
        <div className="text-zinc-500 text-center py-8 border border-zinc-800 rounded-xl bg-zinc-900/30">
          No apps yet
        </div>
      )}

      {!loading && liveApps.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2">
          {liveApps.map((app) => {
            const isFeatured = (app.marketplaceFeatured ?? 0) === 1;
            const isUpdating = featuring === app.id;
            let featuredLabel = "Feature on homepage";
            if (isUpdating) {
              featuredLabel = "Updating...";
            } else if (isFeatured) {
              featuredLabel = "Remove from homepage featured";
            }

            return (
              <div
                key={app.id}
                className="border border-zinc-800 rounded-xl p-4 bg-zinc-900/30"
              >
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="text-base font-semibold text-zinc-200">
                        {app.name}
                      </h3>
                      <span className="px-2 py-0.5 rounded text-xs font-medium bg-emerald-500/20 text-emerald-400">
                        Live
                      </span>
                    </div>
                    {app.subtitle && (
                      <p className="text-xs text-zinc-400">{app.subtitle}</p>
                    )}
                    <div className="flex items-center gap-2 mt-1 text-xs text-zinc-500">
                      {app.category && <span>{app.category}</span>}
                      {app.ownerEmail && (
                        <>
                          <span>•</span>
                          <span>{app.ownerEmail}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <Link
                    href={`/apps/${app.id}`}
                    className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded-lg hover:border-zinc-600 transition-colors shrink-0"
                  >
                    View
                  </Link>
                </div>

                <button
                  type="button"
                  onClick={() => handleToggleFeatured(app.id, !isFeatured)}
                  disabled={isUpdating}
                  className="mt-3 w-full px-3 py-1.5 text-xs text-amber-400 hover:text-amber-300 border border-amber-500/30 hover:border-amber-500/50 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {featuredLabel}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {!loading && apps.length > 0 && (
        <div className="mt-10">
          <h2 className="text-lg font-semibold text-zinc-100">App ownership</h2>
          <p className="text-sm text-zinc-500 mt-1 mb-4">
            Reassign an orphaned app to a reachable user, or grant co-admin
            without moving the billing owner.
          </p>
          <div className="space-y-3">
            {apps.map((app) => {
              const isActing = acting === app.id;
              return (
                <div
                  key={`owner-${app.id}`}
                  className="border border-zinc-800 rounded-xl p-4 bg-zinc-900/30"
                >
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div>
                      <h3 className="text-sm font-semibold text-zinc-200">
                        {app.name}
                      </h3>
                      <p className="text-xs text-zinc-500 mt-1">
                        {app.ownerEmail || app.ownerId || "No owner email"}
                        {app.ownerId ? ` · ${app.ownerId}` : ""}
                      </p>
                    </div>
                    <span className="text-xs text-zinc-500">{app.status}</span>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="flex gap-2">
                      <input
                        type="text"
                        placeholder="New owner user id"
                        value={ownerDrafts[app.id] ?? ""}
                        onChange={(event) =>
                          setOwnerDrafts((prev) => ({
                            ...prev,
                            [app.id]: event.target.value,
                          }))
                        }
                        className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100"
                      />
                      <button
                        type="button"
                        disabled={isActing || !(ownerDrafts[app.id] ?? "").trim()}
                        onClick={() => {
                          void handleReassignOwner(app);
                        }}
                        className="px-3 py-1.5 text-xs text-zinc-200 border border-zinc-700 rounded-lg hover:border-zinc-500 disabled:opacity-50"
                      >
                        Reassign owner
                      </button>
                    </div>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        placeholder="Co-admin user id"
                        value={adminDrafts[app.id] ?? ""}
                        onChange={(event) =>
                          setAdminDrafts((prev) => ({
                            ...prev,
                            [app.id]: event.target.value,
                          }))
                        }
                        className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100"
                      />
                      <button
                        type="button"
                        disabled={isActing || !(adminDrafts[app.id] ?? "").trim()}
                        onClick={() => {
                          void handleGrantCoAdmin(app);
                        }}
                        className="px-3 py-1.5 text-xs text-zinc-200 border border-zinc-700 rounded-lg hover:border-zinc-500 disabled:opacity-50"
                      >
                        Grant co-admin
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
