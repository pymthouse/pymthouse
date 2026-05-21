"use client";

interface Props {
  canEdit: boolean;
  saving: boolean;
  canSave: boolean;
  onSave: () => void;
}

export default function AppSettingsSaveBar({
  canEdit,
  saving,
  canSave,
  onSave,
}: Props) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pt-6">
      <p className="text-xs text-zinc-500 max-w-sm">
        Redirect URIs and domains update immediately. Use{" "}
        <strong className="text-zinc-400">Save changes</strong> for metadata,
        auth mode, scopes, and OIDC fields.
      </p>
      <button
        type="button"
        onClick={onSave}
        disabled={!canEdit || saving || !canSave}
        className="px-5 py-2 text-sm font-medium rounded-md bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
      >
        {saving ? "Saving…" : "Save changes"}
      </button>
    </div>
  );
}
