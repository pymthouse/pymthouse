"use client";

interface Props {
  clientId: string | null;
  curlSnippet: string;
  copiedKey: string | null;
  onCopy: (text: string, label: string) => void;
}

export default function ClientCredentialsQuickstartSection({
  clientId,
  curlSnippet,
  copiedKey,
  onCopy,
}: Props) {
  if (!clientId) return null;

  return (
    <div className="space-y-4 p-5 rounded-xl border border-zinc-800 bg-zinc-900/30">
      <div className="flex items-center gap-2">
        <div className="w-2 h-2 rounded-full bg-cyan-500" />
        <h3 className="text-sm font-semibold text-zinc-200">Client Credentials Quick-start</h3>
      </div>
      <p className="text-xs text-zinc-500">
        Once you have a secret, exchange your credentials for an access token:
      </p>
      <div className="relative">
        <pre className="p-3 bg-zinc-950 border border-zinc-800 rounded-lg text-xs text-zinc-300 font-mono overflow-x-auto whitespace-pre">
          {curlSnippet}
        </pre>
        <button
          onClick={() => onCopy(curlSnippet, "curl")}
          className="absolute top-2 right-2 px-2 py-1 bg-zinc-700 text-zinc-200 rounded text-xs hover:bg-zinc-600 transition-colors"
        >
          {copiedKey === "curl" ? "Copied!" : "Copy"}
        </button>
      </div>
      <div className="flex items-start gap-2 text-xs text-zinc-500">
        <svg className="w-3.5 h-3.5 mt-0.5 shrink-0 text-zinc-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        The response will include an <code className="text-zinc-400 mx-0.5">access_token</code>. Pass it as a Bearer token on all API calls.
      </div>
      <p className="text-xs text-zinc-500">
        The <code className="text-zinc-400">scope</code> value is derived from your app&apos;s allowed scopes (Auth &amp; Scopes). Replace it in the command if your configured scopes differ.
      </p>
    </div>
  );
}
