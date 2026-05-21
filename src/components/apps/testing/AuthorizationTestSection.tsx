"use client";

interface Props {
  redirectUriOptions: string[];
  selectedRedirectUri: string;
  selectedScopes: string[];
  testUrl: string | null;
  onRedirectUriChange: (value: string) => void;
  onOpenTestFlow: () => void;
}

export default function AuthorizationTestSection({
  redirectUriOptions,
  selectedRedirectUri,
  selectedScopes,
  testUrl,
  onRedirectUriChange,
  onOpenTestFlow,
}: Props) {
  return (
    <div className="space-y-4 p-5 rounded-xl border border-zinc-800 bg-zinc-900/30">
      <div className="flex items-center gap-2">
        <div className="w-2 h-2 rounded-full bg-emerald-500" />
        <h3 className="text-sm font-semibold text-zinc-200">Try the authorization code flow</h3>
      </div>
      <p className="text-xs text-zinc-500">
        Uses the redirect URIs from{" "}
        <strong className="text-zinc-400">Auth &amp; Scopes</strong>. Add at least one redirect
        URI there before opening the test.
      </p>
      <div className="border-t border-zinc-800 pt-4">
        {testUrl ? (
          <>
            <label className="block text-sm font-medium text-zinc-300 mb-1.5">
              Test Authorization Code Flow
            </label>
            {redirectUriOptions.length > 1 && (
              <div className="mb-3">
                <label
                  htmlFor="testing-redirect-uri"
                  className="block text-xs font-medium text-zinc-400 mb-1"
                >
                  Redirect URI
                </label>
                <select
                  id="testing-redirect-uri"
                  value={selectedRedirectUri}
                  onChange={(e) => onRedirectUriChange(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                >
                  {redirectUriOptions.map((uri) => (
                    <option key={uri} value={uri}>
                      {uri}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <button
              type="button"
              onClick={onOpenTestFlow}
              className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm hover:bg-emerald-500 transition-colors"
            >
              Open Test Flow
            </button>
            <p className="text-xs text-zinc-500 mt-1.5">
              Opens a new tab with a test authorization request. Make sure you have a redirect URI
              configured that can receive the callback.
            </p>
            <p className="text-xs text-zinc-500 mt-1">
              Requested scopes:{" "}
              <span className="text-zinc-400">{selectedScopes.join(", ")}</span>
            </p>
            <p className="text-xs text-zinc-500 mt-1">
              Using redirect URI:{" "}
              <code className="text-zinc-400">{selectedRedirectUri}</code>
            </p>
          </>
        ) : (
          <p className="text-sm text-zinc-500">
            Add a redirect URI in <strong className="text-zinc-400">Auth &amp; Scopes</strong> to
            enable the test button.
          </p>
        )}
      </div>
    </div>
  );
}
