"use client";

interface BackendHelper {
  clientId: string;
  hasSecret: boolean;
}

interface Props {
  isM2MOnly: boolean;
  clientId: string | null;
  hasSecret: boolean;
  secret: string | null;
  backendHelper: BackendHelper | null;
  backendSecret: string | null;
  backendHelperCurlSnippet: string;
  copiedKey: string | null;
  secretFetchError: string | null;
  backendSecretFetchError: string | null;
  generating: boolean;
  generatingBackend: boolean;
  readOnly: boolean;
  appId: string | null;
  onCopy: (text: string, label: string) => void;
  onGenerateSecret: () => void;
  onGenerateBackendSecret: () => void;
}

export default function TestingCredentialsSection({
  isM2MOnly,
  clientId,
  hasSecret,
  secret,
  backendHelper,
  backendSecret,
  backendHelperCurlSnippet,
  copiedKey,
  secretFetchError,
  backendSecretFetchError,
  generating,
  generatingBackend,
  readOnly,
  appId,
  onCopy,
  onGenerateSecret,
  onGenerateBackendSecret,
}: Props) {
  return (
    <>
      <div className="border-t border-zinc-800" />

      {isM2MOnly ? (
        <>
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1.5">
              Client ID
            </label>
            <div className="flex items-center gap-2">
              <code className="flex-1 px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-emerald-400 text-sm font-mono">
                {clientId || "Create app first"}
              </code>
              {clientId && (
                <button
                  type="button"
                  onClick={() => onCopy(clientId, "clientId")}
                  className="px-3 py-2 bg-zinc-700 text-zinc-200 rounded-lg text-sm hover:bg-zinc-600 transition-colors"
                >
                  {copiedKey === "clientId" ? "Copied!" : "Copy"}
                </button>
              )}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1.5">
              Client Secret
            </label>
            {secret ? (
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <code className="flex-1 px-3 py-2 bg-zinc-800/50 border border-amber-500/30 rounded-lg text-amber-400 text-sm font-mono break-all">
                    {secret}
                  </code>
                  <button
                    type="button"
                    onClick={() => onCopy(secret, "secret")}
                    className="px-3 py-2 bg-zinc-700 text-zinc-200 rounded-lg text-sm hover:bg-zinc-600 transition-colors shrink-0"
                  >
                    {copiedKey === "secret" ? "Copied!" : "Copy"}
                  </button>
                </div>
                <p className="text-xs text-amber-400/80">
                  Store this secret securely. It will not be shown again.
                </p>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                {hasSecret && (
                  <p className="text-sm text-zinc-500">
                    A secret has been generated. Generate a new one to rotate it.
                  </p>
                )}
                <button
                  type="button"
                  onClick={onGenerateSecret}
                  disabled={readOnly || generating || !appId}
                  className="px-4 py-2 bg-zinc-700 text-zinc-200 rounded-lg text-sm hover:bg-zinc-600 disabled:opacity-40 transition-colors"
                >
                  {generating ? "Generating..." : hasSecret ? "Rotate Secret" : "Generate Secret"}
                </button>
              </div>
            )}
            {secretFetchError && (
              <p className="text-xs text-red-400 mt-2">{secretFetchError}</p>
            )}
          </div>
        </>
      ) : (
        <>
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1.5">
              Public / SDK client ID
            </label>
            <p className="text-xs text-zinc-500 mb-2">
              Use this in SDKs, CLIs, and the device authorization flow. It stays public (no secret).
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-emerald-400 text-sm font-mono">
                {clientId || "Create app first"}
              </code>
              {clientId && (
                <button
                  type="button"
                  onClick={() => onCopy(clientId, "clientId")}
                  className="px-3 py-2 bg-zinc-700 text-zinc-200 rounded-lg text-sm hover:bg-zinc-600 transition-colors"
                >
                  {copiedKey === "clientId" ? "Copied!" : "Copy"}
                </button>
              )}
            </div>
          </div>

          {backendHelper ? (
            <div className="mt-6 p-4 rounded-xl border border-cyan-500/20 bg-cyan-500/5 space-y-3">
              <h3 className="text-sm font-semibold text-cyan-200/90">Backend helper (confidential)</h3>
              <p className="text-xs text-zinc-500">
                Use Basic auth with this client for Builder APIs and server-side device approval. Never embed in public apps.
              </p>
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1">Client ID</label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-cyan-300 text-sm font-mono">
                    {backendHelper.clientId}
                  </code>
                  <button
                    type="button"
                    onClick={() => onCopy(backendHelper.clientId, "m2mClientId")}
                    className="px-3 py-2 bg-zinc-700 text-zinc-200 rounded-lg text-sm hover:bg-zinc-600 transition-colors"
                  >
                    {copiedKey === "m2mClientId" ? "Copied!" : "Copy"}
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1">Client Secret</label>
                {backendSecret ? (
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <code className="flex-1 px-3 py-2 bg-zinc-800/50 border border-amber-500/30 rounded-lg text-amber-400 text-sm font-mono break-all">
                        {backendSecret}
                      </code>
                      <button
                        type="button"
                        onClick={() => onCopy(backendSecret, "backendSecret")}
                        className="px-3 py-2 bg-zinc-700 text-zinc-200 rounded-lg text-sm hover:bg-zinc-600 shrink-0"
                      >
                        {copiedKey === "backendSecret" ? "Copied!" : "Copy"}
                      </button>
                    </div>
                    <p className="text-xs text-amber-400/80">
                      Store this secret securely. It will not be shown again.
                    </p>
                  </div>
                ) : (
                  <div className="flex items-center gap-3 flex-wrap">
                    {backendHelper.hasSecret && (
                      <p className="text-sm text-zinc-500">
                        A secret exists. Generate a new one to rotate.
                      </p>
                    )}
                    <button
                      type="button"
                      onClick={onGenerateBackendSecret}
                      disabled={readOnly || generatingBackend || !appId}
                      className="px-4 py-2 bg-zinc-700 text-zinc-200 rounded-lg text-sm hover:bg-zinc-600 disabled:opacity-40 transition-colors"
                    >
                      {generatingBackend
                        ? "Generating..."
                        : backendHelper.hasSecret
                          ? "Rotate Secret"
                          : "Generate Secret"}
                    </button>
                  </div>
                )}
                {backendSecretFetchError && (
                  <p className="text-xs text-red-400 mt-2">{backendSecretFetchError}</p>
                )}
              </div>
              {backendHelperCurlSnippet ? (
                <div className="pt-3 border-t border-cyan-500/15 space-y-2">
                  <h4 className="text-xs font-semibold text-cyan-200/80">
                    Test client credentials (bearer token)
                  </h4>
                  <p className="text-xs text-zinc-500">
                    Run this where your server runs. Replace{" "}
                    <code className="text-zinc-400">YOUR_CLIENT_SECRET</code> with the secret above (or
                    one you have stored). The JSON response includes{" "}
                    <code className="text-zinc-400">access_token</code> — use{" "}
                    <code className="text-zinc-400">Authorization: Bearer …</code> on Builder routes.
                    Scopes match the backend helper client (Builder / device approval), not the public
                    app list.
                  </p>
                  <div className="relative">
                    <pre className="p-3 bg-zinc-950 border border-zinc-800 rounded-lg text-xs text-zinc-300 font-mono overflow-x-auto whitespace-pre">
                      {backendHelperCurlSnippet}
                    </pre>
                    <button
                      type="button"
                      onClick={() => onCopy(backendHelperCurlSnippet, "curlBackend")}
                      className="absolute top-2 right-2 px-2 py-1 bg-zinc-700 text-zinc-200 rounded text-xs hover:bg-zinc-600 transition-colors"
                    >
                      {copiedKey === "curlBackend" ? "Copied!" : "Copy"}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-zinc-500 mt-4">
              Enable <strong className="text-zinc-400">Backend device helper</strong> in Auth &amp; Scopes,
              save, then return here to create a confidential <code className="font-mono text-zinc-400">m2m_</code> client
              for Builder APIs and NaaP-side device approval.
            </p>
          )}
        </>
      )}
    </>
  );
}
