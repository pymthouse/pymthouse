"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppFormData } from "../AppWizard";
import { computeBackendM2mAllowedScopes } from "@/lib/oidc/backend-m2m-scopes";
import { DEFAULT_OIDC_SCOPES, getScopeDefinition, OIDC_SCOPES } from "@/lib/oidc/scopes";
import { validateInitiateLoginUri } from "@/lib/oidc/third-party-initiate-login";
import AuthorizationCodeRedirectBlock from "./AuthorizationCodeRedirectBlock";

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

interface Props {
  appId: string | null;
  clientId: string | null;
  grantTypes: string[];
  /** Primary (app_) client auth method. "none" => public, no secret may exist. */
  tokenEndpointAuthMethod: string;
  redirectUris: string[];
  allowedScopes: string;
  hasSecret: boolean;
  /** Confidential M2M sibling (Builder + device approval token exchange); null until provisioned. */
  backendHelper: { clientId: string; hasSecret: boolean } | null;
  /** Auth & Scopes → confidential backend helper (may be false while M2M still exists until save). */
  backendDeviceHelper: boolean;
  initiateLoginUri: string;
  deviceThirdPartyInitiateLogin: boolean;
  domains: { id: string; domain: string }[];
  onChange: (updates: Partial<AppFormData>) => void;
  onDomainsChange: (domains: { id: string; domain: string }[]) => void;
  onSecretGenerated: () => void;
  onBackendSecretGenerated?: () => void;
  readOnly?: boolean;
}

function getDefaultRedirectUri(redirectUris: string[]) {
  return redirectUris.find((uri) => /^https?:\/\//i.test(uri)) ?? redirectUris[0] ?? "";
}

function isValidInitiateLoginUri(uri: string): boolean {
  const trimmed = uri.trim();
  if (!trimmed.length) return false;
  try {
    validateInitiateLoginUri(trimmed);
    return true;
  } catch {
    return false;
  }
}

export default function TestingStep({
  appId,
  clientId,
  grantTypes,
  tokenEndpointAuthMethod,
  redirectUris,
  allowedScopes,
  hasSecret,
  backendHelper,
  backendDeviceHelper,
  initiateLoginUri,
  deviceThirdPartyInitiateLogin,
  domains,
  onChange,
  onDomainsChange,
  onSecretGenerated,
  onBackendSecretGenerated,
  readOnly = false,
}: Props) {
  const [secret, setSecret] = useState<string | null>(null);
  const [backendSecret, setBackendSecret] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generatingBackend, setGeneratingBackend] = useState(false);
  const [secretFetchError, setSecretFetchError] = useState<string | null>(null);
  const [backendSecretFetchError, setBackendSecretFetchError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [selectedRedirectUri, setSelectedRedirectUri] = useState(() =>
    getDefaultRedirectUri(redirectUris),
  );
  const copyResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hasAuthCodeFlow = grantTypes.includes("authorization_code");
  const hasDeviceCode = grantTypes.includes(DEVICE_CODE_GRANT);
  // The primary client may only hold a secret when it is confidential. A public
  // client (token_endpoint_auth_method === "none") never surfaces a secret or
  // rotate control, regardless of its grant types — confidential credentials live
  // exclusively on the m2m_ backend helper.
  // When an m2m_ backend helper exists, app_ is always public regardless of stale DB auth.
  const primaryIsConfidential =
    backendHelper == null && tokenEndpointAuthMethod !== "none";
  const isM2MOnly =
    backendHelper == null &&
    primaryIsConfidential &&
    grantTypes.includes("client_credentials") &&
    !hasAuthCodeFlow;

  const discoveryUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/.well-known/openid-configuration`
      : "";

  const parseCredentialsError = async (res: Response): Promise<string> => {
    const text = await res.text();
    try {
      const data = text ? JSON.parse(text) : {};
      if (
        typeof data.error_description === "string" &&
        data.error_description.trim()
      ) {
        return data.error_description.trim();
      }
      if (typeof data.error === "string" && data.error) return data.error;
    } catch {
      /* keep generic */
    }
    return text.trim() || res.statusText || `Failed to generate secret (${res.status})`;
  };

  useEffect(() => {
    return () => {
      if (copyResetTimeoutRef.current !== null) {
        clearTimeout(copyResetTimeoutRef.current);
        copyResetTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    setSelectedRedirectUri((current) => {
      if (current && redirectUris.includes(current)) return current;
      return getDefaultRedirectUri(redirectUris);
    });
  }, [redirectUris]);

  useEffect(() => {
    if (!backendDeviceHelper) {
      setBackendSecret(null);
      setBackendSecretFetchError(null);
    }
  }, [backendDeviceHelper]);

  const generateSecret = useCallback(async () => {
    if (readOnly || !appId) return;
    setGenerating(true);
    setSecretFetchError(null);
    try {
      const res = await fetch(`/api/v1/apps/${appId}/credentials`, {
        method: "POST",
      });
      if (!res.ok) {
        setSecretFetchError(await parseCredentialsError(res));
        return;
      }
      const data = (await res.json()) as { clientSecret?: string };
      setSecret(data.clientSecret ?? null);
      onSecretGenerated();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not reach the server. Check your connection and try again.";
      setSecretFetchError(message);
    } finally {
      setGenerating(false);
    }
  }, [appId, onSecretGenerated, readOnly]);

  const generateBackendSecret = useCallback(async () => {
    if (readOnly || !appId || !backendDeviceHelper) return;
    setGeneratingBackend(true);
    setBackendSecretFetchError(null);
    try {
      const res = await fetch(`/api/v1/apps/${appId}/credentials`, {
        method: "POST",
      });
      if (!res.ok) {
        setBackendSecretFetchError(await parseCredentialsError(res));
        return;
      }
      const data = (await res.json()) as { clientSecret?: string };
      setBackendSecret(data.clientSecret ?? null);
      onBackendSecretGenerated?.();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not reach the server. Check your connection and try again.";
      setBackendSecretFetchError(message);
    } finally {
      setGeneratingBackend(false);
    }
  }, [appId, backendDeviceHelper, onBackendSecretGenerated, readOnly]);

  const copyToClipboard = useCallback(
    async (text: string, label: string) => {
      if (typeof navigator === "undefined" || !navigator.clipboard) {
        setCopyError("Clipboard is unavailable in this browser.");
        return;
      }

      try {
        await navigator.clipboard.writeText(text);
      } catch (err) {
        console.error("Failed to copy to clipboard.", err);
        setCopied(null);
        setCopyError("Could not copy to clipboard. Please copy the value manually.");
        return;
      }

      setCopyError(null);
      setCopied(label);
      if (copyResetTimeoutRef.current !== null) {
        clearTimeout(copyResetTimeoutRef.current);
      }
      copyResetTimeoutRef.current = setTimeout(() => {
        copyResetTimeoutRef.current = null;
        setCopied(null);
      }, 2000);
    },
    []
  );

  const redirectUriOptions = useMemo(() => redirectUris, [redirectUris]);

  // Strip scopes that have been removed from the catalog so stale DB values
  // never leak into displayed snippets or test URLs.
  const validScopeValues = new Set(OIDC_SCOPES.map((s) => s.value));
  const effectiveScopes = allowedScopes
    .split(/\s+/)
    .filter((s) => s && validScopeValues.has(s))
    .join(" ");

  const selectedScopes = effectiveScopes
    .split(/\s+/)
    .filter(Boolean)
    .map((scope) => getScopeDefinition(scope)?.label || scope);
  const testUrl =
    clientId && selectedRedirectUri && typeof window !== "undefined"
      ? `${window.location.origin}/api/v1/oidc/authorize?${new URLSearchParams({
          client_id: clientId,
          redirect_uri: selectedRedirectUri,
          response_type: "code",
          scope: effectiveScopes,
          state: "test",
          code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
          code_challenge_method: "S256",
        }).toString()}`
      : null;

  const m2mClientIdForSnippet = isM2MOnly ? clientId : backendHelper?.clientId ?? null;

  const scopesForM2mSnippet =
    allowedScopes
      .split(/\s+/)
      .filter((s) => s && validScopeValues.has(s) && s !== "openid")
      .join(" ") || "YOUR_CONFIGURED_SCOPES";

  const m2mCurlSnippet = m2mClientIdForSnippet
    ? `curl -X POST ${typeof window !== "undefined" ? window.location.origin : ""}/api/v1/oidc/token \\
  -H "Content-Type: application/x-www-form-urlencoded" \\
  -d "grant_type=client_credentials" \\
  -d "client_id=${m2mClientIdForSnippet}" \\
  -d "client_secret=YOUR_CLIENT_SECRET" \\
  -d "scope=${scopesForM2mSnippet}"`
    : "";

  const backendHelperScopes = computeBackendM2mAllowedScopes(
    allowedScopes ?? DEFAULT_OIDC_SCOPES,
  );
  const backendHelperCurlSnippet = backendHelper?.clientId
    ? `curl -X POST ${typeof window !== "undefined" ? window.location.origin : ""}/api/v1/oidc/token \\
  -H "Content-Type: application/x-www-form-urlencoded" \\
  -d "grant_type=client_credentials" \\
  -d "client_id=${backendHelper.clientId}" \\
  -d "client_secret=YOUR_CLIENT_SECRET" \\
  -d "scope=${backendHelperScopes}"`
    : "";

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-zinc-100 mb-1">Credentials &amp; URLs</h2>
        <p className="text-sm text-zinc-500">
          {isM2MOnly
            ? "Generate your client secret, then test your M2M token request."
            : "Configure redirect URLs, generate and rotate credentials, try a live authorization request, and copy reference endpoints."}
        </p>
        {copyError && <p className="text-xs text-red-400 mt-2">{copyError}</p>}
      </div>

      {hasAuthCodeFlow && (
        <div className="space-y-5 p-5 rounded-xl border border-zinc-800 bg-zinc-900/30">
          {redirectUris.length === 0 && (
            <div
              className="flex gap-3 rounded-lg border border-blue-500/25 bg-blue-500/5 px-3 py-3"
              role="status"
            >
              <svg
                className="w-4 h-4 mt-0.5 shrink-0 text-blue-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-medium text-zinc-200">Try the authorization code flow</p>
                <p className="text-xs text-zinc-400">
                  Add at least one redirect URI below. Once saved, you can open a live authorization
                  request in a new tab to verify sign-in end to end.
                </p>
              </div>
            </div>
          )}

          <div>
            <h3 className="text-sm font-semibold text-zinc-200">Redirect &amp; login URLs</h3>
            <p className="text-xs text-zinc-500 mt-1">
              Callback URLs for authorization and sign-out. Domains are auto-suggested from redirect
              origins.
            </p>
          </div>
          <AuthorizationCodeRedirectBlock
            appId={appId}
            redirectUris={redirectUris}
            onRedirectUrisChange={(uris) => onChange({ redirectUris: uris })}
            domains={domains}
            onDomainsChange={onDomainsChange}
            readOnly={readOnly}
          />

          {testUrl && (
            <div className="space-y-3 border-t border-zinc-800 pt-5">
              <div>
                <h4 className="text-sm font-semibold text-zinc-200">Try the authorization code flow</h4>
                <p className="text-xs text-zinc-500 mt-1">
                  Opens a new tab with a test authorization request using your configured redirect
                  URI.
                </p>
              </div>
              {redirectUriOptions.length > 1 && (
                <div>
                  <label
                    htmlFor="testing-redirect-uri"
                    className="block text-xs font-medium text-zinc-400 mb-1"
                  >
                    Redirect URI
                  </label>
                  <select
                    id="testing-redirect-uri"
                    value={selectedRedirectUri}
                    onChange={(e) => setSelectedRedirectUri(e.target.value)}
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
                onClick={() => {
                  const newWin = window.open(testUrl, "_blank", "noopener,noreferrer");
                  if (newWin) newWin.opener = null;
                }}
                className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm hover:bg-emerald-500 transition-colors"
              >
                Open Test Flow
              </button>
              <p className="text-xs text-zinc-500">
                Requested scopes:{" "}
                <span className="text-zinc-400">{selectedScopes.join(", ")}</span>
              </p>
              <p className="text-xs text-zinc-500">
                Using redirect URI:{" "}
                <code className="text-zinc-400">{selectedRedirectUri}</code>
              </p>
            </div>
          )}

          {backendDeviceHelper && hasDeviceCode && (
            <div className="border-t border-zinc-800 pt-5">
              <div className="space-y-2">
                <label className="block text-sm font-medium text-zinc-300">
                  Third-party initiate login URI
                </label>
                <input
                  type="url"
                  value={initiateLoginUri}
                  onChange={(e) => {
                    const value = e.target.value;
                    const isValid = isValidInitiateLoginUri(value);
                    const scopes = allowedScopes.split(/\s+/).filter(Boolean);
                    const nextScopes = isValid
                      ? scopes.includes("users:token")
                        ? scopes
                        : [...scopes, "users:token"]
                      : scopes.filter((s) => s !== "users:token");
                    onChange({
                      initiateLoginUri: value,
                      deviceThirdPartyInitiateLogin: isValid,
                      allowedScopes: nextScopes.join(" "),
                    });
                  }}
                  placeholder="https://example.com/api/auth/initiate-login"
                  disabled={readOnly}
                  className="w-full px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-sm text-zinc-100 placeholder:text-zinc-600 disabled:opacity-50 disabled:cursor-not-allowed"
                />
                <p className="text-xs text-zinc-500">
                  OIDC <code className="font-mono text-zinc-400">initiate_login_uri</code>.
                  When set, unauthenticated device verification redirects here with{" "}
                  <code className="font-mono text-zinc-400">iss</code> and{" "}
                  <code className="font-mono text-zinc-400">target_link_uri</code>. Your app must
                  return users to <code className="font-mono text-zinc-400">target_link_uri</code>{" "}
                  after login.
                </p>
                {initiateLoginUri.trim() && !deviceThirdPartyInitiateLogin && (
                  <p className="text-xs text-amber-300">
                    Enter a valid HTTPS initiate login URI. HTTP is only accepted for loopback hosts
                    in development.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* M2M Quick-start */}
      {isM2MOnly && clientId && (
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
              {m2mCurlSnippet}
            </pre>
            <button
              onClick={() => copyToClipboard(m2mCurlSnippet, "curl")}
              className="absolute top-2 right-2 px-2 py-1 bg-zinc-700 text-zinc-200 rounded text-xs hover:bg-zinc-600 transition-colors"
            >
              {copied === "curl" ? "Copied!" : "Copy"}
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
      )}

      {/* Divider */}
      <div className="border-t border-zinc-800" />

      {primaryIsConfidential ? (
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
                  onClick={() => copyToClipboard(clientId, "clientId")}
                  className="px-3 py-2 bg-zinc-700 text-zinc-200 rounded-lg text-sm hover:bg-zinc-600 transition-colors"
                >
                  {copied === "clientId" ? "Copied!" : "Copy"}
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
                    onClick={() => copyToClipboard(secret, "secret")}
                    className="px-3 py-2 bg-zinc-700 text-zinc-200 rounded-lg text-sm hover:bg-zinc-600 transition-colors shrink-0"
                  >
                    {copied === "secret" ? "Copied!" : "Copy"}
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
                  onClick={() => void generateSecret()}
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
                  onClick={() => copyToClipboard(clientId, "clientId")}
                  className="px-3 py-2 bg-zinc-700 text-zinc-200 rounded-lg text-sm hover:bg-zinc-600 transition-colors"
                >
                  {copied === "clientId" ? "Copied!" : "Copy"}
                </button>
              )}
            </div>
          </div>

        </>
      )}

      {/*
        Backend helper (confidential m2m_) — driven by server state
        (`backendHelper` / `backendDeviceHelper`), refreshed when the
        Credentials tab loads and after save.
      */}
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
                onClick={() => copyToClipboard(backendHelper.clientId, "m2mClientId")}
                className="px-3 py-2 bg-zinc-700 text-zinc-200 rounded-lg text-sm hover:bg-zinc-600 transition-colors"
              >
                {copied === "m2mClientId" ? "Copied!" : "Copy"}
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
                    onClick={() => copyToClipboard(backendSecret, "backendSecret")}
                    className="px-3 py-2 bg-zinc-700 text-zinc-200 rounded-lg text-sm hover:bg-zinc-600 shrink-0"
                  >
                    {copied === "backendSecret" ? "Copied!" : "Copy"}
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
                  onClick={() => void generateBackendSecret()}
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
                  onClick={() =>
                    copyToClipboard(backendHelperCurlSnippet, "curlBackend")
                  }
                  className="absolute top-2 right-2 px-2 py-1 bg-zinc-700 text-zinc-200 rounded text-xs hover:bg-zinc-600 transition-colors"
                >
                  {copied === "curlBackend" ? "Copied!" : "Copy"}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : !isM2MOnly && backendDeviceHelper ? (
        <p className="text-sm text-zinc-500 mt-4">
          <strong className="text-zinc-400">Backend device helper</strong> is enabled but not yet provisioned.
          Save the app to provision the Backend device helper and create a confidential{" "}
          <code className="font-mono text-zinc-400">m2m_</code> client for Builder APIs and NaaP-side device
          approval, then return here.
        </p>
      ) : !isM2MOnly ? (
        <p className="text-sm text-zinc-500 mt-4">
          Confidential backend helper is off in{" "}
          <strong className="text-zinc-400">Auth &amp; Scopes</strong>. Turn on{" "}
          <strong className="text-zinc-400">Confidential client (CLIENT CREDENTIALS)</strong>{" "}
          there to manage M2M credentials on this tab.
        </p>
      ) : null}

      {/* Discovery URL */}
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
              onClick={() => copyToClipboard(discoveryUrl, "discovery")}
              className="px-3 py-2 bg-zinc-700 text-zinc-200 rounded-lg text-sm hover:bg-zinc-600 transition-colors shrink-0"
            >
              {copied === "discovery" ? "Copied!" : "Copy"}
            </button>
          )}
        </div>
      </div>

      {/* Integration Checklist */}
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
    </div>
  );
}
