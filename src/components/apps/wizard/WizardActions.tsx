"use client";

interface Props {
  canSubmit: boolean;
  saving: boolean;
  onCancel: () => void;
}

export default function WizardActions({
  canSubmit,
  saving,
  onCancel,
}: Props) {
  return (
    <div className="flex items-center gap-4 pt-2">
      <button
        type="submit"
        disabled={!canSubmit}
        className="px-4 py-2 text-sm font-medium rounded-md bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {saving ? "Registering…" : "Register application"}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="text-sm text-emerald-500 hover:underline"
      >
        Cancel
      </button>
    </div>
  );
}
