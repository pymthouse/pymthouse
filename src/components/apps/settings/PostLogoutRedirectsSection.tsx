"use client";

interface Props {
  canEdit: boolean;
  newPostLogoutUri: string;
  postLogoutRedirectUris: string[];
  onNewUriChange: (value: string) => void;
  onAddUri: () => void;
  onRemoveUri: (uri: string) => void;
}

export default function PostLogoutRedirectsSection({
  canEdit,
  newPostLogoutUri,
  postLogoutRedirectUris,
  onNewUriChange,
  onAddUri,
  onRemoveUri,
}: Props) {
  return (
    <section className="py-6 space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-zinc-100">Post-logout Redirects</h2>
        <p className="text-sm text-zinc-500 mt-1">
          URIs to redirect users to after sign-out. Saved with{" "}
          <strong className="text-zinc-400">Save changes</strong> below.
        </p>
      </div>
      <div>
        <label className="block text-sm font-medium text-zinc-300 mb-1.5">
          Post-logout redirect URIs
        </label>
        <div className="flex gap-2 mb-2">
          <input
            type="text"
            value={newPostLogoutUri}
            onChange={(e) => onNewUriChange(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), onAddUri())}
            placeholder="https://example.com/logout-complete"
            disabled={!canEdit}
            className="flex-1 px-3 py-1.5 bg-zinc-900 border border-zinc-700 rounded-md text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500/50 disabled:opacity-50 disabled:cursor-not-allowed"
          />
          <button
            type="button"
            onClick={onAddUri}
            disabled={!canEdit}
            className="px-4 py-1.5 rounded-md bg-zinc-700 text-zinc-200 text-sm hover:bg-zinc-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Add
          </button>
        </div>
        <div className="space-y-1.5">
          {postLogoutRedirectUris.map((uri) => (
            <div
              key={uri}
              className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2"
            >
              <code className="text-xs text-zinc-300">{uri}</code>
              <button
                type="button"
                onClick={() => onRemoveUri(uri)}
                disabled={!canEdit}
                className="text-xs text-zinc-500 hover:text-red-400 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
