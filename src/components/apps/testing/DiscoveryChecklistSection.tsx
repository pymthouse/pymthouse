"use client";

interface Props {
  discoveryUrl: string;
  copiedKey: string | null;
  hasAuthCodeFlow: boolean;
  onCopy: (text: string, label: string) => void;
}

export default function DiscoveryChecklistSection({
  discoveryUrl,
  copiedKey,
  hasAuthCodeFlow,
  onCopy,
}: Props) {
  return (
    <>
      <div>
        <label className="block text-sm font-medium text-zinc-300 mb-1.5">
          OIDC Discovery URL
        </label>
        <div className="flex items-center gap-2">
          <code className="flex-1 px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-zinc-300 text-sm font-mono truncate">
            {discoveryUrl}
          </code>
          {discoveryUrl && (
            <button
              onClick={() => onCopy(discoveryUrl, "discovery")}
              className="px-3 py-2 bg-zinc-700 text-zinc-200 rounded-lg text-sm hover:bg-zinc-600 transition-colors shrink-0"
            >
              {copiedKey === "discovery" ? "Copied!" : "Copy"}
            </button>
          )}
        </div>
      </div>

      <div className="p-4 bg-zinc-800/30 rounded-lg border border-zinc-800">
        <p className="text-sm font-medium text-zinc-300 mb-3">
          Integration Checklist
        </p>
        <div className="space-y-2">
          {[
            ...(hasAuthCodeFlow
              ? [
                  "Redirect URI is configured and accessible",
                  "Token exchange works (authorization_code grant)",
                ]
              : []),
            "User token issuance works for a provisioned app user",
            "Refresh token flow works (if enabled)",
          ].map((item) => (
            <div key={item} className="flex items-center gap-2">
              <div className="w-4 h-4 rounded border border-zinc-600" />
              <span className="text-sm text-zinc-400">{item}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
