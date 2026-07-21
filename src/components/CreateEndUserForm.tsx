"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function CreateEndUserForm() {
  const router = useRouter();
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    email: "",
  });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);

    try {
      const res = await fetch("/api/v1/end-users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });
      const data = await res.json();

      if (res.ok) {
        setShowForm(false);
        setFormData({ name: "", email: "" });
        router.refresh();
      } else {
        setError(data.error || "Failed to create user");
      }
    } catch {
      setError("Failed to connect to API");
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setShowForm(!showForm);
          setError(null);
        }}
        className="px-4 py-2 bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 rounded-lg text-sm font-medium hover:bg-emerald-500/20 transition-colors"
      >
        {showForm ? "Cancel" : "New User"}
      </button>

      {showForm && (
        <div className="absolute right-5 top-16 z-10 w-80 border border-zinc-700 rounded-xl p-5 bg-zinc-900 shadow-xl">
          <h4 className="font-semibold text-zinc-200 mb-3 text-sm">
            Create End User
          </h4>
          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label htmlFor="end-user-name" className="block text-xs text-zinc-500 mb-1">
                Name
              </label>
              <input
                id="end-user-name"
                type="text"
                value={formData.name}
                onChange={(e) =>
                  setFormData({ ...formData, name: e.target.value })
                }
                className="w-full px-3 py-1.5 bg-zinc-800/50 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:outline-none focus:border-emerald-500/50"
                placeholder="Jane Doe"
              />
            </div>
            <div>
              <label htmlFor="end-user-email" className="block text-xs text-zinc-500 mb-1">
                Email
              </label>
              <input
                id="end-user-email"
                type="email"
                value={formData.email}
                onChange={(e) =>
                  setFormData({ ...formData, email: e.target.value })
                }
                className="w-full px-3 py-1.5 bg-zinc-800/50 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:outline-none focus:border-emerald-500/50"
                placeholder="jane@example.com"
              />
            </div>
            {error && (
              <p className="text-xs text-red-400">{error}</p>
            )}
            <button
              type="submit"
              disabled={creating}
              className="w-full px-3 py-1.5 bg-emerald-500 text-white rounded-lg text-sm font-medium hover:bg-emerald-600 transition-colors disabled:opacity-50"
            >
              {creating ? "Creating..." : "Create"}
            </button>
          </form>
        </div>
      )}
    </>
  );
}
