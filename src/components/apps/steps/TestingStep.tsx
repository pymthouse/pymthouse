"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { AppFormData } from "../AppWizard";
import {
  computeBackendM2mClientCredentialsScopes,
  publicAppAllowsSignJob,
} from "@/lib/oidc/backend-m2m-scopes";
import {
  DEFAULT_OIDC_SCOPES,
  getScopeDefinition,
  OIDC_SCOPES,
} from "@/lib/oidc/scopes";
import { validateInitiateLoginUri } from "@/lib/oidc/third-party-initiate-login";
import {
  AUTHORIZATION_CODE_GRANT,
  DEVICE_CODE_GRANT,
  syncPublicClientGrantTypes,
} from "@/lib/oidc/grants";
import AuthorizationCodeRedirectBlock from "./AuthorizationCodeRedirectBlock";

const API_REFERENCE_URL = "https://pymthouse.com/api/v1/docs";

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
  /** App profile → Confidential M2M backend (may be false while M2M still exists until save). */
  backendDeviceHelper: boolean;
  initiateLoginUri: string;
  deviceThirdPartyInitiateLogin: boolean;
  domains: { id: string; domain: string }[];
  onChange: (updates: Partial<AppFormData>) => void;
  onDomainsChange: (domains: { id: string; domain: string }[]) => void;
  onSecretGenerated: () => void;
  onBackendSecretGenerated?: () => void;
  readOnly?: boolean;
  /** When true, the redirect URI / domain editor is omitted (managed from Credentials & URLs tab). */
  hideRedirectUriEditor?: boolean;
  /** When true, the authorization-code test block is omitted (rendered separately below Sign-in URLs). */
  hideAuthCodeFlowSection?: boolean;
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

function getBrowserOrigin(): string {
  return globalThis.window?.location.origin ?? "";
}

function buildClientCredentialsCurl(
  origin: string,
  clientId: string,
  scope: string,
): string {
  return String.raw`curl -sS -X POST ${origin}/api/v1/oidc/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "client_id=${clientId}" \
  -d "client_secret=YOUR_CLIENT_SECRET" \
  -d "scope=${scope}"`;
}

function buildM2mAdminCurl(
  origin: string,
  clientId: string,
  adminScopes: string,
): string {
  return buildClientCredentialsCurl(
    origin,
    clientId,
    adminScopes || "users:write users:token device:approve",
  );
}

function buildOwnerSignJobCurl(origin: string, clientId: string): string {
  return buildClientCredentialsCurl(origin, clientId, "sign:job");
}

const TOKEN_EXCHANGE_GRANT =
  "urn:ietf:params:oauth:grant-type:token-exchange";
const SUBJECT_ACCESS_TOKEN_TYPE =
  "urn:ietf:params:oauth:token-type:access_token";

function buildOpaqueSignerSessionCurl(origin: string, clientId: string): string {
  return String.raw`# 1) Mint a short-lived sign:job JWT (remote signing flow)
curl -sS -X POST ${origin}/api/v1/oidc/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "client_id=${clientId}" \
  -d "client_secret=YOUR_CLIENT_SECRET" \
  -d "scope=sign:job"

# 2) Exchange it for a long-lived opaque pmth_* signer session (no resource parameter):
curl -sS -X POST ${origin}/api/v1/oidc/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=${TOKEN_EXCHANGE_GRANT}" \
  -d "client_id=${clientId}" \
  -d "client_secret=YOUR_CLIENT_SECRET" \
  -d "subject_token=YOUR_SHORT_LIVED_JWT" \
  -d "subject_token_type=${SUBJECT_ACCESS_TOKEN_TYPE}" \
  -d "scope=sign:job"`;
}

type M2mTokenTestKind = "admin" | "owner";
type SigningTokenFormat = "jwt" | "bearer";

async function postOidcToken(body: URLSearchParams): Promise<Record<string, unknown>> {
  const res = await fetch("/api/v1/oidc/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* keep empty */
  }
  if (!res.ok) {
    const description = getOidcErrorDescription(data, res.statusText);
    throw new Error(description || `Request failed (${res.status})`);
  }
  return data;
}

async function postM2mClientCredentials(input: {
  clientId: string;
  clientSecret: string;
  scope: string;
  externalUserId?: string;
}): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: input.clientId,
    client_secret: input.clientSecret,
    scope: input.scope,
  });
  if (input.externalUserId?.trim()) {
    body.set("external_user_id", input.externalUserId.trim());
  }
  return postOidcToken(body);
}

async function postM2mTokenExchange(input: {
  clientId: string;
  clientSecret: string;
  subjectToken: string;
}): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({
    grant_type: TOKEN_EXCHANGE_GRANT,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    subject_token: input.subjectToken,
    subject_token_type: SUBJECT_ACCESS_TOKEN_TYPE,
    scope: "sign:job",
  });
  return postOidcToken(body);
}

function extractAccessToken(data: Record<string, unknown>): string | null {
  if (typeof data.access_token === "string" && data.access_token.trim()) {
    return data.access_token.trim();
  }
  const token = data.token;
  if (token && typeof token === "object" && !Array.isArray(token)) {
    const nested = token as Record<string, unknown>;
    if (typeof nested.access_token === "string" && nested.access_token.trim()) {
      return nested.access_token.trim();
    }
    if (typeof nested.accessToken === "string" && nested.accessToken.trim()) {
      return nested.accessToken.trim();
    }
  }
  return null;
}

function formatTokenTestResult(data: Record<string, unknown>): string {
  const redacted = { ...data };
  if (typeof redacted.access_token === "string" && redacted.access_token.length > 24) {
    redacted.access_token = `${redacted.access_token.slice(0, 12)}…${redacted.access_token.slice(-8)}`;
  }
  return JSON.stringify(redacted, null, 2);
}

function getOidcErrorDescription(data: Record<string, unknown>, fallbackStatus: string): string {
  if (typeof data.error_description === "string") return data.error_description;
  if (typeof data.error === "string") return data.error;
  return fallbackStatus;
}

function resolveActiveM2mKind(
  showFlowPicker: boolean,
  availableFlows: M2mTokenTestKind[],
  selectedKind: M2mTokenTestKind,
): M2mTokenTestKind {
  if (!showFlowPicker) return availableFlows[0] ?? "admin";
  if (availableFlows.includes(selectedKind)) return selectedKind;
  return availableFlows[0] ?? "admin";
}

function resolveCurlForM2mSelection(
  activeKind: M2mTokenTestKind,
  useBearerSigning: boolean,
  origin: string,
  clientId: string,
  adminScopes: string,
): string {
  if (activeKind === "admin") return buildM2mAdminCurl(origin, clientId, adminScopes);
  if (useBearerSigning) return buildOpaqueSignerSessionCurl(origin, clientId);
  return buildOwnerSignJobCurl(origin, clientId);
}

function getM2mIntroText(showFlowPicker: boolean, showRemoteSigning: boolean): string | null {
  if (showFlowPicker) return null;
  if (showRemoteSigning) {
    return "Review the curl below, then exchange credentials for a remote-signing token.";
  }
  return "Review the curl below, then exchange credentials for an administrative token.";
}

function getCredentialsIntroText(isM2MOnly: boolean, hideAuthCodeFlowSection: boolean): string {
  if (isM2MOnly) return "Generate your client secret, then test your M2M token request.";
  if (hideAuthCodeFlowSection) {
    return "Generate and rotate credentials, then test token exchange.";
  }
  return "Configure redirect URLs, generate and rotate credentials, try a live authorization request, and copy reference endpoints.";
}

function scopesForInitiateLoginUri(allowedScopes: string, isValid: boolean): string {
  const scopes = allowedScopes.split(/[,\s]+/).filter(Boolean);
  if (!isValid) return scopes.filter((scope) => scope !== "users:token").join(" ");
  if (scopes.includes("users:token")) return scopes.join(" ");
  return [...scopes, "users:token"].join(" ");
}

function buildAuthorizeTestUrl(
  clientId: string,
  redirectUri: string,
  effectiveScopes: string,
  origin: string,
): string {
  return `${origin}/api/v1/oidc/authorize?${new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: effectiveScopes,
    state: "test",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
  }).toString()}`;
}

async function executeM2mTokenTest(input: {
  activeKind: M2mTokenTestKind;
  useBearerSigning: boolean;
  adminScopes: string;
  clientId: string;
  effectiveSecret: string;
}): Promise<{ result: string; rawAccessToken: string | null }> {
  if (input.activeKind === "owner" && input.useBearerSigning) {
    const mintData = await postM2mClientCredentials({
      clientId: input.clientId,
      clientSecret: input.effectiveSecret,
      scope: "sign:job",
    });
    const subjectJwt = extractAccessToken(mintData);
    if (!subjectJwt) {
      throw new Error("Remote signing mint did not return an access_token.");
    }
    const data = await postM2mTokenExchange({
      clientId: input.clientId,
      clientSecret: input.effectiveSecret,
      subjectToken: subjectJwt,
    });
    return {
      result: formatTokenTestResult(data),
      rawAccessToken: extractAccessToken(data),
    };
  }

  const scope =
    input.activeKind === "admin"
      ? input.adminScopes || (() => { throw new Error("No administrative scopes are configured."); })()
      : "sign:job";
  const data = await postM2mClientCredentials({
    clientId: input.clientId,
    clientSecret: input.effectiveSecret,
    scope,
  });
  return {
    result: formatTokenTestResult(data),
    rawAccessToken: extractAccessToken(data),
  };
}

type SigningTokenFormatToggleProps = Readonly<{
  value: SigningTokenFormat;
  onChange: (next: SigningTokenFormat) => void;
  readOnly: boolean;
  clientId: string;
}>;

function SigningTokenFormatToggle({
  value,
  onChange,
  readOnly,
  clientId,
}: SigningTokenFormatToggleProps) {
  return (
    <div className="mt-2 pt-2 border-t border-zinc-700/50 flex justify-end">
      <fieldset
        aria-label="Signing token format"
        className="relative inline-grid grid-cols-2 w-[7.25rem] rounded-md bg-zinc-950 border border-zinc-600/90 p-px m-0 min-w-0"
      >
        <div
          className={[
            "pointer-events-none absolute top-px bottom-px w-[calc(50%-1px)] rounded-[5px]",
            "bg-zinc-600 shadow-sm",
            "transition-[left] duration-200 ease-out motion-reduce:transition-none",
            value === "jwt" ? "left-px" : "left-[calc(50%)]",
          ].join(" ")}
          aria-hidden
        />
        {(["jwt", "bearer"] as const).map((option) => {
          const selected = value === option;
          return (
            <button
              key={option}
              type="button"
              id={`signing-format-${option}-${clientId}`}
              role="radio"
              aria-checked={selected}
              disabled={readOnly}
              onClick={(event) => {
                event.stopPropagation();
                onChange(option);
              }}
              className={[
                "relative z-10 py-0.5 text-[10px] font-mono font-medium uppercase tracking-wide",
                "transition-colors duration-200 motion-reduce:transition-none",
                "disabled:opacity-50 disabled:cursor-not-allowed",
                selected ? "text-zinc-100" : "text-zinc-500 hover:text-zinc-400",
              ].join(" ")}
            >
              {option === "jwt" ? "JWT" : "Bearer"}
            </button>
          );
        })}
      </fieldset>
    </div>
  );
}

type M2mTokenTestPanelProps = Readonly<{
  clientId: string;
  generatedSecret: string | null;
  allowedScopes: string;
  readOnly: boolean;
  origin: string;
  onCopy: (text: string, label: string) => void;
  copiedLabel: string | null;
  showTopBorder?: boolean;
  /** When false, only remote signing is available (no confidential m2m_ backend helper). */
  hasM2mBackend: boolean;
}>;

function m2mOptionButtonClass(kind: M2mTokenTestKind, activeKind: M2mTokenTestKind, accent: "zinc" | "emerald") {
  const selected = activeKind === kind;
  const base =
    "rounded-lg border px-3 py-3 text-left transition-colors w-full h-full flex flex-col";
  if (accent === "emerald") {
    return [
      base,
      selected
        ? "border-emerald-500/50 bg-emerald-500/10 ring-1 ring-emerald-500/40"
        : "border-zinc-700 bg-zinc-800/50 hover:bg-zinc-800",
    ].join(" ");
  }
  return [
    base,
    selected
      ? "border-zinc-500 bg-zinc-800 ring-1 ring-zinc-500/50"
      : "border-zinc-700 bg-zinc-800/50 hover:bg-zinc-800",
  ].join(" ");
}

function M2mSingleFlowHint({
  showRemoteSigning,
  showAdministrative,
  bearerFormatToggle,
}: Readonly<{
  showRemoteSigning: boolean;
  showAdministrative: boolean;
  bearerFormatToggle: ReactNode;
}>): ReactNode {
  if (showRemoteSigning) {
    return (
      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-3">
        <span className="block text-xs font-semibold text-emerald-100/90">Remote signing</span>
        <span className="mt-1 block text-[11px] text-zinc-500">
          Payment signing tokens for your app owner identity.
        </span>
        {bearerFormatToggle}
      </div>
    );
  }
  if (showAdministrative) {
    return (
      <p className="text-xs text-zinc-400">
        <span className="font-semibold text-zinc-200">Administrative access</span>
        {" — "}Builder APIs, user provisioning, and device approval.
      </p>
    );
  }
  return null;
}

function M2mTokenTestResult({
  error,
  result,
  rawAccessToken,
  onCopy,
  copiedLabel,
  tokenCopyLabel,
}: Readonly<{
  error: string | null;
  result: string | null;
  rawAccessToken: string | null;
  onCopy: (text: string, label: string) => void;
  copiedLabel: string | null;
  tokenCopyLabel: string;
}>): ReactNode {
  return (
    <>
      {error ? <p className="text-xs text-red-400">{error}</p> : null}
      {result ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-zinc-400">Response</p>
            {rawAccessToken ? (
              <button
                type="button"
                onClick={() => onCopy(rawAccessToken, tokenCopyLabel)}
                className="px-2 py-1 bg-zinc-700 text-zinc-200 rounded text-xs hover:bg-zinc-600 transition-colors shrink-0"
              >
                {copiedLabel === tokenCopyLabel ? "Copied!" : "Copy token"}
              </button>
            ) : null}
          </div>
          <pre className="p-3 bg-zinc-950 border border-zinc-800 rounded-lg text-xs text-emerald-300/90 font-mono overflow-x-auto whitespace-pre-wrap">
            {result}
          </pre>
        </div>
      ) : null}
    </>
  );
}

function M2mFlowSelection({
  showFlowPicker,
  showAdministrative,
  showRemoteSigning,
  activeKind,
  readOnly,
  selectKind,
  bearerFormatToggle,
}: Readonly<{
  showFlowPicker: boolean;
  showAdministrative: boolean;
  showRemoteSigning: boolean;
  activeKind: M2mTokenTestKind;
  readOnly: boolean;
  selectKind: (kind: M2mTokenTestKind) => void;
  bearerFormatToggle: ReactNode;
}>): ReactNode {
  if (showFlowPicker) {
    return (
      <div className="grid gap-2 sm:grid-cols-2 items-stretch" role="radiogroup" aria-label="Token type">
        {showAdministrative ? (
          <button
            type="button"
            role="radio"
            aria-checked={activeKind === "admin"}
            onClick={() => selectKind("admin")}
            disabled={readOnly}
            className={m2mOptionButtonClass("admin", activeKind, "zinc")}
          >
            <span className="block text-xs font-semibold leading-4 min-h-8 text-zinc-100">
              Administrative access
            </span>
            <span className="mt-1 block text-[11px] text-zinc-500">
              Builder APIs, user provisioning, and device approval
            </span>
          </button>
        ) : null}
        {showRemoteSigning ? (
          <div
            role="radio"
            aria-checked={activeKind === "owner"}
            onClick={() => !readOnly && selectKind("owner")}
            onKeyDown={(e) => {
              if (!readOnly && (e.key === "Enter" || e.key === " ")) {
                e.preventDefault();
                selectKind("owner");
              }
            }}
            tabIndex={readOnly ? -1 : 0}
            className={`${m2mOptionButtonClass("owner", activeKind, "emerald")} cursor-pointer`}
          >
            <span className="block text-xs font-semibold leading-4 min-h-8 text-emerald-100">
              Remote signing
            </span>
            <span className="mt-1 block text-[11px] text-zinc-500">
              Payment signing tokens for your app owner identity
            </span>
            {bearerFormatToggle}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <M2mSingleFlowHint
      showRemoteSigning={showRemoteSigning}
      showAdministrative={showAdministrative}
      bearerFormatToggle={bearerFormatToggle}
    />
  );
}

function M2mTokenTestPanel({
  clientId,
  generatedSecret,
  allowedScopes,
  readOnly,
  origin,
  onCopy,
  copiedLabel,
  showTopBorder = true,
  hasM2mBackend,
}: M2mTokenTestPanelProps) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [rawAccessToken, setRawAccessToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clientSecretInput, setClientSecretInput] = useState("");
  const [selectedKind, setSelectedKind] = useState<M2mTokenTestKind>("admin");
  const [signingTokenFormat, setSigningTokenFormat] = useState<SigningTokenFormat>("jwt");
  const [curlDetailsOpen, setCurlDetailsOpen] = useState(true);

  const adminScopes = computeBackendM2mClientCredentialsScopes(
    allowedScopes || DEFAULT_OIDC_SCOPES,
  );
  const canSignJob = publicAppAllowsSignJob(allowedScopes || DEFAULT_OIDC_SCOPES);
  const showAdministrative = hasM2mBackend && Boolean(adminScopes);
  const showRemoteSigning = canSignJob;
  const canUseBearerSigning = hasM2mBackend && canSignJob;
  const availableFlows = useMemo(
    (): M2mTokenTestKind[] => [
      ...(showAdministrative ? (["admin"] as const) : []),
      ...(showRemoteSigning ? (["owner"] as const) : []),
    ],
    [showAdministrative, showRemoteSigning],
  );
  const showFlowPicker = availableFlows.length > 1;
  const effectiveSecret = clientSecretInput.trim();
  const activeKind = resolveActiveM2mKind(showFlowPicker, availableFlows, selectedKind);
  const useBearerSigning =
    activeKind === "owner" && canUseBearerSigning && signingTokenFormat === "bearer";
  const curlForSelection = resolveCurlForM2mSelection(
    activeKind,
    useBearerSigning,
    origin,
    clientId,
    adminScopes,
  );
  const curlCopyLabel = `curlM2m-${clientId}-${activeKind}-${useBearerSigning ? "bearer" : "jwt"}`;
  const tokenCopyLabel = `tokenM2m-${clientId}`;
  const introText = getM2mIntroText(showFlowPicker, showRemoteSigning);

  useEffect(() => {
    if (generatedSecret) {
      setClientSecretInput(generatedSecret);
    }
  }, [generatedSecret]);

  useEffect(() => {
    if (!availableFlows.includes(selectedKind) && availableFlows[0]) {
      setSelectedKind(availableFlows[0]);
    }
  }, [availableFlows, selectedKind]);

  useEffect(() => {
    if (!canUseBearerSigning && signingTokenFormat === "bearer") {
      setSigningTokenFormat("jwt");
    }
  }, [canUseBearerSigning, signingTokenFormat]);

  const selectKind = useCallback((kind: M2mTokenTestKind) => {
    setSelectedKind(kind);
    setError(null);
  }, []);

  const bearerFormatToggle = canUseBearerSigning ? (
    <SigningTokenFormatToggle
      value={signingTokenFormat}
      clientId={clientId}
      readOnly={readOnly}
      onChange={(next) => {
        selectKind("owner");
        setSigningTokenFormat(next);
      }}
    />
  ) : null;

  const runTest = useCallback(async () => {
    if (!effectiveSecret || readOnly) {
      setError("Enter your client secret to run a test token exchange.");
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    setRawAccessToken(null);
    try {
      const exchange = await executeM2mTokenTest({
        activeKind,
        useBearerSigning,
        adminScopes,
        clientId,
        effectiveSecret,
      });
      setResult(exchange.result);
      setRawAccessToken(exchange.rawAccessToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Token request failed.");
    } finally {
      setLoading(false);
    }
  }, [activeKind, adminScopes, clientId, effectiveSecret, readOnly, useBearerSigning]);

  return (
    <div className={`space-y-4 ${showTopBorder ? "pt-3 border-t border-zinc-800" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-xs font-semibold text-zinc-200">Test token exchange</h4>
          {introText ? <p className="text-xs text-zinc-500 mt-1">{introText}</p> : null}
        </div>
        <a
          href={API_REFERENCE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 inline-flex items-center gap-1 text-[10px] font-medium text-zinc-500 hover:text-emerald-400 transition-colors"
        >
          API Reference
          <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </a>
      </div>

      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-zinc-400" htmlFor={`m2m-secret-${clientId}`}>
          Client secret
        </label>
        <input
          id={`m2m-secret-${clientId}`}
          type="password"
          value={clientSecretInput}
          onChange={(e) => setClientSecretInput(e.target.value)}
          placeholder="pmth_cs_…"
          autoComplete="off"
          disabled={readOnly}
          className="w-full px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-sm text-zinc-100 font-mono placeholder:text-zinc-600 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-green-bright/30"
        />
        <p className="text-xs text-zinc-500">
          Paste a secret you have stored, or generate one above — it fills in here automatically once.
        </p>
      </div>

      <M2mFlowSelection
        showFlowPicker={showFlowPicker}
        showAdministrative={showAdministrative}
        showRemoteSigning={showRemoteSigning}
        activeKind={activeKind}
        readOnly={readOnly}
        selectKind={selectKind}
        bearerFormatToggle={bearerFormatToggle}
      />

      <details
        className="rounded-lg border border-zinc-800 bg-zinc-950/50"
        open={curlDetailsOpen}
        onToggle={(event) => setCurlDetailsOpen(event.currentTarget.open)}
      >
        <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-zinc-400 hover:text-zinc-300">
          Curl reference for selected flow
        </summary>
        <div className="relative border-t border-zinc-800">
          <pre className="p-3 text-xs text-zinc-300 font-mono overflow-x-auto whitespace-pre">
            {curlForSelection}
          </pre>
          <button
            type="button"
            onClick={() => onCopy(curlForSelection, curlCopyLabel)}
            className="absolute top-2 right-2 px-2 py-1 bg-zinc-700 text-zinc-200 rounded text-xs hover:bg-zinc-600 transition-colors"
          >
            {copiedLabel === curlCopyLabel ? "Copied!" : "Copy"}
          </button>
        </div>
      </details>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => {
            runTest();
          }}
          disabled={readOnly || loading || availableFlows.length === 0}
          className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-500 disabled:opacity-40 transition-colors"
        >
          {loading ? "Exchanging…" : "Exchange token"}
        </button>
      </div>

      <M2mTokenTestResult
        error={error}
        result={result}
        rawAccessToken={rawAccessToken}
        onCopy={onCopy}
        copiedLabel={copiedLabel}
        tokenCopyLabel={tokenCopyLabel}
      />
    </div>
  );
}

export interface AuthCodeFlowTestSectionProps {
  appId: string | null;
  clientId: string | null;
  grantTypes: string[];
  redirectUris: string[];
  allowedScopes: string;
  backendDeviceHelper: boolean;
  initiateLoginUri: string;
  deviceThirdPartyInitiateLogin: boolean;
  domains: { id: string; domain: string }[];
  onChange: (updates: Partial<AppFormData>) => void;
  onDomainsChange: (domains: { id: string; domain: string }[]) => void;
  readOnly?: boolean;
  showRedirectUriEditor?: boolean;
}

function DeviceInitiateLoginUriField({
  initiateLoginUri,
  deviceThirdPartyInitiateLogin,
  allowedScopes,
  readOnly,
  onChange,
}: Readonly<{
  initiateLoginUri: string;
  deviceThirdPartyInitiateLogin: boolean;
  allowedScopes: string;
  readOnly: boolean;
  onChange: (updates: Partial<AppFormData>) => void;
}>): ReactNode {
  return (
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
            onChange({
              initiateLoginUri: value,
              deviceThirdPartyInitiateLogin: isValid,
              allowedScopes: scopesForInitiateLoginUri(allowedScopes, isValid),
            });
          }}
          placeholder="https://example.com/api/auth/initiate-login"
          disabled={readOnly}
          className="w-full px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-sm text-zinc-100 placeholder:text-zinc-600 disabled:opacity-50 disabled:cursor-not-allowed"
        />
        <p className="text-xs text-zinc-500">
          OIDC <code className="font-mono text-zinc-400">initiate_login_uri</code>. When set,
          unauthenticated device verification redirects here with{" "}
          <code className="font-mono text-zinc-400">iss</code> and{" "}
          <code className="font-mono text-zinc-400">target_link_uri</code>. Your app must return
          users to <code className="font-mono text-zinc-400">target_link_uri</code> after login.
        </p>
        {initiateLoginUri.trim() && !deviceThirdPartyInitiateLogin ? (
          <p className="text-xs text-amber-300">
            Enter a valid HTTPS initiate login URI. HTTP is only accepted for loopback hosts in
            development.
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function AuthCodeFlowTestSection({
  appId,
  clientId,
  grantTypes,
  redirectUris,
  allowedScopes,
  backendDeviceHelper,
  initiateLoginUri,
  deviceThirdPartyInitiateLogin,
  domains,
  onChange,
  onDomainsChange,
  readOnly = false,
  showRedirectUriEditor = false,
}: Readonly<AuthCodeFlowTestSectionProps>) {
  const [selectedRedirectUri, setSelectedRedirectUri] = useState(() =>
    getDefaultRedirectUri(redirectUris),
  );

  const effectiveGrantTypes = useMemo(
    () => syncPublicClientGrantTypes(grantTypes, redirectUris, clientId ?? ""),
    [grantTypes, redirectUris, clientId],
  );
  const hasAuthCodeFlow = effectiveGrantTypes.includes(AUTHORIZATION_CODE_GRANT);
  const hasDeviceCode = effectiveGrantTypes.includes(DEVICE_CODE_GRANT);

  const effectiveSelectedRedirectUri =
    selectedRedirectUri && redirectUris.includes(selectedRedirectUri)
      ? selectedRedirectUri
      : getDefaultRedirectUri(redirectUris);

  const redirectUriOptions = useMemo(() => redirectUris, [redirectUris]);

  const validScopeValues = new Set(OIDC_SCOPES.map((s) => s.value));
  const effectiveScopes = allowedScopes
    .split(/[,\s]+/)
    .filter((s) => s && validScopeValues.has(s))
    .join(" ");

  const selectedScopes = effectiveScopes
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((scope) => getScopeDefinition(scope)?.label || scope);

  const browserOrigin = getBrowserOrigin();
  const testUrl =
    clientId && effectiveSelectedRedirectUri && browserOrigin
      ? buildAuthorizeTestUrl(clientId, effectiveSelectedRedirectUri, effectiveScopes, browserOrigin)
      : null;

  if (!hasAuthCodeFlow) return null;

  return (
    <div className="space-y-5 p-5 rounded-xl border border-zinc-800 bg-zinc-900/30">
      {showRedirectUriEditor && redirectUris.length === 0 ? (
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
      ) : null}

      {showRedirectUriEditor ? (
        <>
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
        </>
      ) : null}

      {testUrl ? (
        <div className={`space-y-3 ${showRedirectUriEditor ? "border-t border-zinc-800 pt-5" : ""}`}>
          <div>
            <h4 className="text-sm font-semibold text-zinc-200">Try the authorization code flow</h4>
            <p className="text-xs text-zinc-500 mt-1">
              Opens a new tab with a test authorization request using your configured redirect URI.
            </p>
          </div>
          {redirectUriOptions.length > 1 ? (
            <div>
              <label
                htmlFor="testing-redirect-uri"
                className="block text-xs font-medium text-zinc-400 mb-1"
              >
                Redirect URI
              </label>
              <select
                id="testing-redirect-uri"
                value={effectiveSelectedRedirectUri}
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
          ) : null}
          <button
            type="button"
            onClick={() => {
              const newWin = globalThis.window?.open(testUrl, "_blank", "noopener,noreferrer");
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
            <code className="text-zinc-400">{effectiveSelectedRedirectUri}</code>
          </p>
        </div>
      ) : null}

      {backendDeviceHelper && hasDeviceCode ? (
        <DeviceInitiateLoginUriField
          initiateLoginUri={initiateLoginUri}
          deviceThirdPartyInitiateLogin={deviceThirdPartyInitiateLogin}
          allowedScopes={allowedScopes}
          readOnly={readOnly}
          onChange={onChange}
        />
      ) : null}
    </div>
  );
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
  hideRedirectUriEditor = false,
  hideAuthCodeFlowSection = false,
}: Props) {
  const [secret, setSecret] = useState<string | null>(null);
  const [backendSecret, setBackendSecret] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generatingBackend, setGeneratingBackend] = useState(false);
  const [secretFetchError, setSecretFetchError] = useState<string | null>(null);
  const [backendSecretFetchError, setBackendSecretFetchError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const copyResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const effectiveGrantTypes = useMemo(
    () => syncPublicClientGrantTypes(grantTypes, redirectUris, clientId ?? ""),
    [grantTypes, redirectUris, clientId],
  );
  const hasAuthCodeFlow = effectiveGrantTypes.includes(AUTHORIZATION_CODE_GRANT);
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

  const m2mSecretForTests = isM2MOnly ? secret : backendSecret;
  const browserOrigin = getBrowserOrigin();
  const hasM2mBackend =
    Boolean(backendHelper?.clientId) || Boolean(clientId?.startsWith("m2m_"));

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100 mb-1">Credentials &amp; URLs</h2>
          <p className="text-sm text-zinc-500">
            {getCredentialsIntroText(isM2MOnly, hideAuthCodeFlowSection)}
          </p>
        </div>
        <a
          href={API_REFERENCE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 inline-flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-800/50 px-2.5 py-1.5 text-xs font-medium text-zinc-400 hover:border-emerald-500/40 hover:text-emerald-400 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
          </svg>
          API Reference
          <svg className="w-3 h-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </a>
      </div>
      {copyError && <p className="text-xs text-red-400 mt-2">{copyError}</p>}

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
        <div className="p-4 rounded-xl border border-cyan-500/20 bg-cyan-500/5 space-y-3">
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
          {backendHelper?.clientId ? (
            <M2mTokenTestPanel
              clientId={backendHelper.clientId}
              generatedSecret={m2mSecretForTests}
              allowedScopes={allowedScopes ?? DEFAULT_OIDC_SCOPES}
              readOnly={readOnly}
              origin={browserOrigin}
              onCopy={copyToClipboard}
              copiedLabel={copied}
              hasM2mBackend
            />
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
          Confidential M2M backend is off on{" "}
          <strong className="text-zinc-400">App profile</strong>. Turn on{" "}
          <strong className="text-zinc-400">Confidential M2M backend</strong>{" "}
          there to manage M2M credentials on this tab.
        </p>
      ) : null}

      {isM2MOnly && clientId ? (
        <div className="space-y-4 p-5 rounded-xl border border-zinc-800 bg-zinc-900/30">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-cyan-500" />
            <h3 className="text-sm font-semibold text-zinc-200">M2M token exchange</h3>
          </div>
          <M2mTokenTestPanel
            clientId={clientId}
            generatedSecret={m2mSecretForTests}
            allowedScopes={allowedScopes ?? DEFAULT_OIDC_SCOPES}
            readOnly={readOnly}
            origin={browserOrigin}
            onCopy={copyToClipboard}
            copiedLabel={copied}
            showTopBorder={false}
            hasM2mBackend={hasM2mBackend}
          />
        </div>
      ) : null}

      {hideAuthCodeFlowSection ? null : (
        <AuthCodeFlowTestSection
          appId={appId}
          clientId={clientId}
          grantTypes={grantTypes}
          redirectUris={redirectUris}
          allowedScopes={allowedScopes}
          backendDeviceHelper={backendDeviceHelper}
          initiateLoginUri={initiateLoginUri}
          deviceThirdPartyInitiateLogin={deviceThirdPartyInitiateLogin}
          domains={domains}
          onChange={onChange}
          onDomainsChange={onDomainsChange}
          readOnly={readOnly}
          showRedirectUriEditor={!hideRedirectUriEditor}
        />
      )}
    </div>
  );
}

