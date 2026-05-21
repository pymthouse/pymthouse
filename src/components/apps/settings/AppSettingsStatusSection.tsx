"use client";

interface Props {
  canEdit: boolean;
  canSubmitForReview: boolean;
  appStatus: string;
  submittingForReview: boolean;
  reverting: boolean;
  error: string | null;
  message: string | null;
  onSubmitForReview: () => void;
  onRevertToDraft: () => void;
}

export default function AppSettingsStatusSection({
  canEdit,
  canSubmitForReview,
  appStatus,
  submittingForReview,
  reverting,
  error,
  message,
  onSubmitForReview,
  onRevertToDraft,
}: Props) {
  return (
    <div className="space-y-3 pb-6">
      {!canEdit && (
        <div className="p-3 rounded-md bg-amber-500/10 border border-amber-500/25 text-amber-200 text-sm">
          You can view this app&apos;s configuration. Only platform or app
          administrators can change settings.
        </div>
      )}
      {canEdit &&
        canSubmitForReview &&
        (appStatus === "draft" || appStatus === "rejected") && (
          <div className="p-4 rounded-md border border-blue-500/25 bg-blue-500/5 space-y-3">
            <div>
              <h2 className="text-sm font-semibold text-zinc-100">Submit for review</h2>
              <p className="text-sm text-zinc-400 mt-1">
                While this app is in draft, only you and platform staff can use
                it. Submit it when you are ready so an administrator can approve
                it for production.
              </p>
            </div>
            <button
              type="button"
              onClick={onSubmitForReview}
              disabled={submittingForReview}
              className="px-4 py-2 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {submittingForReview ? "Submitting…" : "Submit for review"}
            </button>
          </div>
        )}
      {canEdit &&
        canSubmitForReview &&
        appStatus === "submitted" && (
          <div className="p-4 rounded-md border border-amber-500/25 bg-amber-500/5 space-y-3">
            <div>
              <h2 className="text-sm font-semibold text-zinc-100">Revert to draft</h2>
              <p className="text-sm text-zinc-400 mt-1">
                This app is waiting for administrator review. You can withdraw it
                from the queue to make changes, then submit again.
              </p>
            </div>
            <button
              type="button"
              onClick={onRevertToDraft}
              disabled={reverting}
              className="px-4 py-2 text-sm font-medium rounded-md border border-amber-500/40 text-amber-200 hover:bg-amber-500/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {reverting ? "Reverting…" : "Revert to draft"}
            </button>
          </div>
        )}
      {error && (
        <div className="p-3 rounded-md bg-red-500/10 border border-red-500/20 text-red-300 text-sm">
          {error}
        </div>
      )}
      {message && (
        <div className="p-3 rounded-md bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-sm">
          {message}
        </div>
      )}
    </div>
  );
}
