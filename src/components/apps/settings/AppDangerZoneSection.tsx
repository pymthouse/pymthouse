"use client";

interface Props {
  visible: boolean;
  deleting: boolean;
  onDelete: () => void;
}

export default function AppDangerZoneSection({
  visible,
  deleting,
  onDelete,
}: Props) {
  if (!visible) return null;

  return (
    <section className="py-6 space-y-3">
      <h2 className="text-sm font-semibold text-zinc-100">Delete draft app</h2>
      <p className="text-sm text-zinc-400">
        Permanently remove this app, its OIDC client, and related data. This
        cannot be undone.
      </p>
      <button
        type="button"
        onClick={onDelete}
        disabled={deleting}
        className="px-4 py-2 text-sm font-medium rounded-md border border-red-500/40 text-red-300 hover:bg-red-500/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {deleting ? "Deleting…" : "Delete app"}
      </button>
    </section>
  );
}
