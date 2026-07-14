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
import { mintOwnerApiKey } from "../mint-owner-api-key";
import ApiKeyCredentialSwitcher from "@/components/apps/ApiKeyCredentialSwitcher";

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
  ownerExternalUserId?: string | null;
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

function buildSignerTokenExchangeCurl(origin: string, publicClientId: string): string {
  const encodedClientId = encodeURIComponent(publicClientId);
  return String.raw`curl -sS -X POST ${origin}/api/v1/apps/${encodedClientId}/oidc/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=${TOKEN_EXCHANGE_GRANT}" \
  -d "subject_token=${publicClientId}_YOUR_BARE_API_KEY" \
  -d "subject_token_type=${SUBJECT_ACCESS_TOKEN_TYPE}"`;
}

function buildDeviceAuthorizeCurl(origin: string, publicClientId: string): string {
  return String.raw`curl -sS -X POST ${origin}/api/v1/oidc/device/auth \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=${publicClientId}" \
  -d "scope=openid sign:job"`;
}

function buildDevicePollCurl(origin: string, publicClientId: string): string {
  return String.raw`curl -sS -X POST ${origin}/api/v1/oidc/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=${DEVICE_CODE_GRANT}" \
  -d "device_code=DEVICE_CODE_FROM_STEP_1" \
  -d "client_id=${publicClientId}"`;
}

function buildBearerUsageCurl(publicClientId: string): string {
  return String.raw`curl -sS https://your-signer.example/path \
  -H "Authorization: Bearer ${publicClientId}_YOUR_BARE_API_KEY"`;
}

type CurlSnippet = Readonly<{
  id: string;
  title: string;
  body: string;
}>;

function resolveCurlSnippetsForSelection(input: {
  activeKind: M2mTokenTestKind;
  useBearerSigning: boolean;
  origin: string;
  m2mClientId: string;
  publicClientId: string | null;
  adminScopes: string;
}): CurlSnippet[] {
  const {
    activeKind,
    useBearerSigning,
    origin,
    m2mClientId,
    publicClientId,
    adminScopes,
  } = input;
  if (activeKind === "admin") {
    return [
      {
        id: "admin-cc",
        title: "Client credentials (administrative)",
        body: buildM2mAdminCurl(origin, m2mClientId, adminScopes),
      },
    ];
  }

  if (useBearerSigning && publicClientId) {
    return [
      {
        id: "bearer-usage",
        title: "2. Use the API key as Bearer",
        body: buildBearerUsageCurl(publicClientId),
      },
      {
        id: "api-key-exchange",
        title: "3. Exchange API key for signer JWT (optional)",
        body: buildSignerTokenExchangeCurl(origin, publicClientId),
      },
    ];
  }

  if (publicClientId) {
    // JWT test action mints an owner API key then exchanges it; device code is
    // the end-user alternative, not what the panel button runs.
    return [
      {
        id: "api-key-exchange",
        title: "1. Exchange owner API key for signer JWT",
        body: buildSignerTokenExchangeCurl(origin, publicClientId),
      },
      {
        id: "device-auth",
        title: "End-user alternative: start device authorization",
        body: buildDeviceAuthorizeCurl(origin, publicClientId),
      },
      {
        id: "device-poll",
        title: "End-user alternative: poll for signer JWT",
        body: buildDevicePollCurl(origin, publicClientId),
      },
    ];
  }

  return [
    {
      id: "owner-sign-job",
      title: "Client credentials (sign:job)",
      body: buildOwnerSignJobCurl(origin, m2mClientId),
    },
  ];
}

function CurlSnippetDetails({
  snippet,
  onCopy,
  copiedLabel,
}: Readonly<{
  snippet: CurlSnippet;
  onCopy: (text: string, label: string) => void;
  copiedLabel: string | null;
}>): ReactNode {
  const copyLabel = `curl-${snippet.id}`;
  return (
    <details className="rounded-lg border border-zinc-800 bg-zinc-950/50">
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-zinc-400 hover:text-zinc-300">
        {snippet.title}
      </summary>
      <div className="relative border-t border-zinc-800">
        <pre className="p-3 text-xs text-zinc-300 font-mono overflow-x-auto whitespace-pre">
          {snippet.body}
        </pre>
        <button
          type="button"
          onClick={() => onCopy(snippet.body, copyLabel)}
          className="absolute top-2 right-2 px-2 py-1 bg-zinc-700 text-zinc-200 rounded text-xs hover:bg-zinc-600 transition-colors"
        >
          {copiedLabel === copyLabel ? "Copied!" : "Copy"}
        </button>
      </div>
    </details>
  );
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

async function postAppScopedSignerExchange(input: {
  publicClientId: string;
  subjectToken: string;
}): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({
    grant_type: TOKEN_EXCHANGE_GRANT,
    subject_token: input.subjectToken,
    subject_token_type: SUBJECT_ACCESS_TOKEN_TYPE,
  });
  const res = await fetch(
    `/api/v1/apps/${encodeURIComponent(input.publicClientId)}/oidc/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
  );
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

function maskSecretValue(value: unknown): unknown {
  if (typeof value !== "string" || value.length <= 24) return value;
  return `${value.slice(0, 12)}…${value.slice(-8)}`;
}

const SECRET_RESULT_KEYS = new Set([
  "access_token",
  "accessToken",
  "apiKey",
  "api_key",
]);

function redactTokenFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactTokenFields);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      SECRET_RESULT_KEYS.has(key)
        ? maskSecretValue(nested)
        : redactTokenFields(nested),
    ]),
  );
}

function formatTokenTestResult(data: Record<string, unknown>): string {
  return JSON.stringify(redactTokenFields(data), null, 2);
}

type TokenTestKind = "api_key" | "signer_session" | "jwt";

function tokenTestResultTitle(tokenKind: TokenTestKind | null): string {
  if (tokenKind === "api_key") return "API key";
  if (tokenKind === "signer_session") return "Signer session token";
  if (tokenKind === "jwt") return "Access token";
  return "Token";
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

function getM2mIntroText(showFlowPicker: boolean, showRemoteSigning: boolean): string | null {
  if (showFlowPicker || showRemoteSigning) return null;
  return "Review the curl below, then exchange credentials for an administrative token.";
}

function getSigningFormatHint(format: SigningTokenFormat): string {
  if (format === "bearer") {
    return "Get API Key for a long-lived Bearer token";
  }
  return "Mint an owner API key with your session, then exchange it for a short-lived signer JWT. End users can instead use device code login.";
}

function resolveOwnerSigningFormatHint(
  activeKind: M2mTokenTestKind,
  canUseBearerSigning: boolean,
  signingTokenFormat: SigningTokenFormat,
): string | null {
  if (activeKind !== "owner") return null;
  if (canUseBearerSigning) return getSigningFormatHint(signingTokenFormat);
  return getSigningFormatHint("jwt");
}

function resolveEffectiveAuthTestTab(
  authTestTab: "remote" | "admin",
  showAdminAccessTab: boolean,
  showRemoteSigningTab: boolean,
): "remote" | "admin" {
  if (authTestTab === "admin" && showAdminAccessTab) return "admin";
  if (showRemoteSigningTab) return "remote";
  return "admin";
}

function getTokenTestActionLabel(
  activeKind: M2mTokenTestKind,
  useBearerSigning: boolean,
  loading: boolean,
): string {
  if (activeKind === "owner") {
    if (!useBearerSigning) return loading ? "Exchanging…" : "Exchange token";
    return loading ? "Getting…" : "Get API Key";
  }
  return loading ? "Exchanging…" : "Exchange token";
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

async function executeOwnerTokenTest(input: {
  useBearerSigning: boolean;
  publicClientId: string;
  ownerExternalUserId: string;
}): Promise<{
  result: string;
  rawAccessToken: string | null;
  sdkToken: string | null;
  tokenKind: TokenTestKind;
}> {
  // Remote signing needs no client secret: mint the composite key with the
  // signed-in session (same as the Get API Key easy flow), then either return
  // it as a Bearer key or exchange it once for a signer JWT.
  const minted = await mintOwnerApiKey({
    clientId: input.publicClientId,
    ownerExternalUserId: input.ownerExternalUserId,
  });
  const compositeKey = readTrimmedString(minted.apiKey);
  if (!compositeKey) {
    throw new Error("API key mint response missing apiKey.");
  }
  const sdkToken = readTrimmedString(minted.sdkToken);
  if (input.useBearerSigning) {
    return {
      result: formatTokenTestResult(minted),
      rawAccessToken: compositeKey,
      sdkToken,
      tokenKind: "api_key",
    };
  }
  const exchanged = await postAppScopedSignerExchange({
    publicClientId: input.publicClientId,
    subjectToken: compositeKey,
  });
  return {
    result: formatTokenTestResult(exchanged),
    rawAccessToken: extractAccessToken(exchanged),
    sdkToken: null,
    tokenKind: "jwt",
  };
}

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function resolveAdminOrSignJobScope(
  activeKind: M2mTokenTestKind,
  adminScopes: string,
): string {
  if (activeKind !== "admin") return "sign:job";
  if (!adminScopes) {
    throw new Error("No administrative scopes are configured.");
  }
  return adminScopes;
}

async function executeM2mTokenTest(input: {
  activeKind: M2mTokenTestKind;
  useBearerSigning: boolean;
  adminScopes: string;
  m2mClientId: string;
  publicClientId: string | null;
  ownerExternalUserId: string | null;
  effectiveSecret: string;
}): Promise<{
  result: string;
  rawAccessToken: string | null;
  sdkToken: string | null;
  tokenKind: TokenTestKind;
}> {
  if (input.activeKind === "owner") {
    const publicClientId = input.publicClientId?.trim();
    if (!publicClientId) {
      throw new Error("Public client_id is required for remote signing.");
    }
    const ownerExternalUserId = input.ownerExternalUserId?.trim();
    if (!ownerExternalUserId) {
      throw new Error("App owner identity is unavailable. Refresh the page and retry.");
    }
    return executeOwnerTokenTest({
      useBearerSigning: input.useBearerSigning,
      publicClientId,
      ownerExternalUserId,
    });
  }

  const data = await postM2mClientCredentials({
    clientId: input.m2mClientId,
    clientSecret: input.effectiveSecret,
    scope: resolveAdminOrSignJobScope(input.activeKind, input.adminScopes),
  });
  return {
    result: formatTokenTestResult(data),
    rawAccessToken: extractAccessToken(data),
    sdkToken: null,
    tokenKind: "jwt",
  };
}

type SigningTokenFormatToggleProps = Readonly<{
  value: SigningTokenFormat;
  onChange: (next: SigningTokenFormat) => void;
  readOnly: boolean;
  clientId: string;
  /** When true, omit top border/margin (used below the flow picker row). */
  embedded?: boolean;
}>;

function SigningTokenFormatToggle({
  value,
  onChange,
  readOnly,
  clientId,
  embedded = false,
}: SigningTokenFormatToggleProps) {
  return (
    <div
      className={
        embedded
          ? "flex justify-end"
          : "mt-2 pt-2 border-t border-zinc-700/50 flex justify-end"
      }
    >
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
  publicClientId: string | null;
  ownerExternalUserId: string | null;
  generatedSecret: string | null;
  allowedScopes: string;
  readOnly: boolean;
  origin: string;
  onCopy: (text: string, label: string) => void;
  copiedLabel: string | null;
  showTopBorder?: boolean;
  /** When false, only remote signing is available (no confidential m2m_ backend helper). */
  hasM2mBackend: boolean;
  /**
   * Restrict which token-test flows appear. Defaults to every flow this app
   * can support (admin when a confidential backend exists, remote signing when
   * sign:job is allowed).
   */
  flows?: readonly M2mTokenTestKind[];
}>;

function m2mOptionButtonClass(kind: M2mTokenTestKind, activeKind: M2mTokenTestKind) {
  const selected = activeKind === kind;
  const base =
    "rounded-lg border px-3 py-3 text-left transition-colors w-full h-full min-h-[4.5rem] flex flex-col justify-start";
  return [
    base,
    selected
      ? "border-emerald-500/50 bg-emerald-500/10 ring-1 ring-emerald-500/40"
      : "border-zinc-700 bg-zinc-800/50 hover:bg-zinc-800 hover:border-zinc-600",
  ].join(" ");
}

function m2mOptionTitleClass(selected: boolean) {
  return selected ? "text-emerald-100" : "text-zinc-300";
}

function M2mSingleFlowHint({
  showRemoteSigning,
  showAdministrative,
  bearerFormatToggle,
  signingFormatHint,
}: Readonly<{
  showRemoteSigning: boolean;
  showAdministrative: boolean;
  bearerFormatToggle: ReactNode;
  signingFormatHint: string | null;
}>): ReactNode {
  if (showRemoteSigning) {
    // Section chrome already names the flow; only surface the format toggle + hint.
    if (!bearerFormatToggle && !signingFormatHint) return null;
    return (
      <div className="space-y-2">
        {bearerFormatToggle ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
            <span className="text-[11px] text-zinc-500">Signing token format</span>
            {bearerFormatToggle}
          </div>
        ) : null}
        {signingFormatHint ? (
          <p className="text-[11px] text-zinc-500 leading-relaxed">{signingFormatHint}</p>
        ) : null}
      </div>
    );
  }
  if (showAdministrative) {
    // Section chrome already names the flow.
    return null;
  }
  return null;
}

function M2mTokenCredentialValue({
  rawAccessToken,
  sdkToken,
  tokenKind,
  onCopy,
  copiedLabel,
  tokenCopyLabel,
}: Readonly<{
  rawAccessToken: string | null;
  sdkToken: string | null;
  tokenKind: TokenTestKind | null;
  onCopy: (text: string, label: string) => void;
  copiedLabel: string | null;
  tokenCopyLabel: string;
}>): ReactNode {
  if (!rawAccessToken) return null;
  if (tokenKind === "api_key") {
    return (
      <ApiKeyCredentialSwitcher
        apiKey={rawAccessToken}
        sdkToken={sdkToken}
      />
    );
  }
  return (
    <div className="flex items-start gap-2 rounded-md border border-sky-500/20 bg-black/30 p-2.5">
      <code className="min-w-0 flex-1 break-all font-mono text-xs text-sky-100 leading-relaxed">
        {rawAccessToken}
      </code>
      <button
        type="button"
        onClick={() => onCopy(rawAccessToken, tokenCopyLabel)}
        className="shrink-0 rounded-md border border-sky-500/50 bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-500 transition-colors"
      >
        {copiedLabel === tokenCopyLabel ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function M2mTokenTestResult({
  error,
  result,
  rawAccessToken,
  sdkToken,
  tokenKind,
  onCopy,
  copiedLabel,
  tokenCopyLabel,
  onDismiss,
}: Readonly<{
  error: string | null;
  result: string | null;
  rawAccessToken: string | null;
  sdkToken: string | null;
  tokenKind: TokenTestKind | null;
  onCopy: (text: string, label: string) => void;
  copiedLabel: string | null;
  tokenCopyLabel: string;
  onDismiss: () => void;
}>): ReactNode {
  if (error) {
    return (
      <div
        role="alert"
        className="rounded-lg border border-red-500/30 bg-red-500/10 p-3"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-red-300">Token exchange failed</p>
            <p className="text-xs text-red-200/80 mt-1">{error}</p>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className="shrink-0 inline-flex items-center gap-1 rounded-md border border-red-500/40 px-2 py-1 text-xs font-medium text-red-200 hover:bg-red-500/20 transition-colors"
            aria-label="Clear error from screen"
          >
            <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
            Close
          </button>
        </div>
      </div>
    );
  }

  if (!result) return null;

  return (
    <output className="block rounded-lg border border-sky-500/30 bg-sky-500/10 p-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-sky-200">
            {tokenKind === "api_key" ? "API Key" : tokenTestResultTitle(tokenKind)}
          </p>
          <p
            className={
              tokenKind === "api_key"
                ? "text-[11px] text-amber-300 mt-0.5"
                : "text-[11px] text-sky-300/80 mt-0.5"
            }
          >
            {tokenKind === "api_key"
              ? "Store this securely — it will not be shown again."
              : "Copy the token now for use in your client."}
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 inline-flex items-center gap-1 rounded-md border border-sky-500/40 bg-sky-500/10 px-2 py-1 text-xs font-medium text-sky-100 hover:bg-sky-500/20 transition-colors"
          aria-label="Clear token result from screen"
        >
          <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
          Close
        </button>
      </div>

      <M2mTokenCredentialValue
        rawAccessToken={rawAccessToken}
        sdkToken={sdkToken}
        tokenKind={tokenKind}
        onCopy={onCopy}
        copiedLabel={copiedLabel}
        tokenCopyLabel={tokenCopyLabel}
      />

      {tokenKind === "api_key" ? (
        <p className="text-[11px] text-sky-300/70">
          Use as <span className="font-mono text-sky-200/80">Authorization: Bearer</span> on the
          remote signer, or as <span className="font-mono text-sky-200/80">subject_token</span> at{" "}
          <span className="font-mono text-sky-200/80">
            POST /api/v1/apps/{`{clientId}`}/oidc/token
          </span>
          .
        </p>
      ) : null}
      {tokenKind === "signer_session" ? (
        <p className="text-[11px] text-sky-300/70">
          Opaque signer-session token from RFC 8693 exchange — not a per-user API key.
        </p>
      ) : null}

      <details className="text-[11px] text-sky-300/70">
        <summary className="cursor-pointer hover:text-sky-200">Show full response body</summary>
        <pre className="mt-2 overflow-x-auto rounded-md border border-sky-500/15 bg-black/30 p-2 font-mono text-[10px] text-sky-200/70 whitespace-pre-wrap">
          {result}
        </pre>
      </details>
    </output>
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
  signingFormatHint,
}: Readonly<{
  showFlowPicker: boolean;
  showAdministrative: boolean;
  showRemoteSigning: boolean;
  activeKind: M2mTokenTestKind;
  readOnly: boolean;
  selectKind: (kind: M2mTokenTestKind) => void;
  bearerFormatToggle: ReactNode;
  signingFormatHint: string | null;
}>): ReactNode {
  if (showFlowPicker) {
    return (
      <div className="space-y-2">
        <div className="grid gap-2 sm:grid-cols-2 items-stretch" role="radiogroup" aria-label="Token type">
          {showAdministrative ? (
            <button
              type="button"
              role="radio"
              aria-checked={activeKind === "admin"}
              onClick={() => selectKind("admin")}
              disabled={readOnly}
              className={m2mOptionButtonClass("admin", activeKind)}
            >
              <span
                className={`block text-xs font-semibold leading-snug ${m2mOptionTitleClass(activeKind === "admin")}`}
              >
                Administrative access
              </span>
              <span className="mt-1 block text-[11px] leading-snug text-zinc-500">
                Builder APIs, user provisioning, and device approval
              </span>
            </button>
          ) : null}
          {showRemoteSigning ? (
            <button
              type="button"
              role="radio"
              aria-checked={activeKind === "owner"}
              onClick={() => selectKind("owner")}
              disabled={readOnly}
              className={m2mOptionButtonClass("owner", activeKind)}
            >
              <span
                className={`block text-xs font-semibold leading-snug ${m2mOptionTitleClass(activeKind === "owner")}`}
              >
                Remote signing
              </span>
              <span className="mt-1 block text-[11px] leading-snug text-zinc-500">
                Bearer API key, or mint + exchange for a signer JWT (device code is the end-user path)
              </span>
            </button>
          ) : null}
        </div>
        {activeKind === "owner" ? (
          <div className="space-y-2">
            {bearerFormatToggle ? (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
                <span className="text-[11px] text-zinc-500">Signing token format</span>
                {bearerFormatToggle}
              </div>
            ) : null}
            {signingFormatHint ? (
              <p className="text-[11px] text-zinc-500 leading-relaxed">{signingFormatHint}</p>
            ) : null}
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
      signingFormatHint={signingFormatHint}
    />
  );
}

function resolveM2mPanelFlowFlags(input: {
  flows: readonly M2mTokenTestKind[] | undefined;
  hasM2mBackend: boolean;
  adminScopes: string;
  canSignJob: boolean;
  publicClientId: string | null;
  ownerExternalUserId: string | null;
}): {
  showAdministrative: boolean;
  showRemoteSigning: boolean;
  canUseBearerSigning: boolean;
} {
  const allowAdmin = input.flows ? input.flows.includes("admin") : true;
  const allowOwner = input.flows ? input.flows.includes("owner") : true;
  const showAdministrative =
    allowAdmin && input.hasM2mBackend && Boolean(input.adminScopes);
  const showRemoteSigning =
    allowOwner &&
    input.canSignJob &&
    Boolean(input.publicClientId) &&
    Boolean(input.ownerExternalUserId?.trim());
  return {
    showAdministrative,
    showRemoteSigning,
    canUseBearerSigning: showRemoteSigning,
  };
}

function M2mAdminSecretField({
  clientId,
  clientSecretInput,
  onChange,
  readOnly,
}: Readonly<{
  clientId: string;
  clientSecretInput: string;
  onChange: (value: string) => void;
  readOnly: boolean;
}>) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium text-zinc-400" htmlFor={`m2m-secret-${clientId}`}>
        Client secret
      </label>
      <input
        id={`m2m-secret-${clientId}`}
        type="password"
        value={clientSecretInput}
        onChange={(e) => onChange(e.target.value)}
        placeholder="pmth_cs_…"
        autoComplete="new-password"
        disabled={readOnly}
        className="w-full px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-sm text-zinc-100 font-mono placeholder:text-zinc-600 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-green-bright/30"
      />
      <p className="text-xs text-zinc-500">
        Paste the Backend helper client secret, or generate/rotate one in that section — it fills in here
        automatically once.
      </p>
    </div>
  );
}

function M2mOwnerKeyAction({
  actionLabel,
  loading,
  disabled,
  onRun,
}: Readonly<{
  actionLabel: string;
  loading: boolean;
  disabled: boolean;
  onRun: () => void;
}>) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2.5">
      <span className="text-[11px] text-zinc-500">1. Get API Key</span>
      <button
        type="button"
        onClick={onRun}
        disabled={disabled}
        className="inline-flex items-center gap-1.5 rounded-md border border-emerald-600/50 px-2.5 py-1.5 text-xs font-medium text-emerald-400 transition-colors hover:border-emerald-500 hover:bg-emerald-500/10 hover:text-emerald-300 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? (
          <span
            className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-emerald-600/40 border-t-emerald-400"
            aria-hidden
          />
        ) : (
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.75}
              d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"
            />
          </svg>
        )}
        {actionLabel}
      </button>
    </div>
  );
}

function M2mTokenTestPanel({
  clientId,
  publicClientId,
  ownerExternalUserId,
  generatedSecret,
  allowedScopes,
  readOnly,
  origin,
  onCopy,
  copiedLabel,
  showTopBorder = true,
  hasM2mBackend,
  flows,
}: M2mTokenTestPanelProps) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [rawAccessToken, setRawAccessToken] = useState<string | null>(null);
  const [sdkToken, setSdkToken] = useState<string | null>(null);
  const [resultTokenKind, setResultTokenKind] = useState<TokenTestKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clientSecretInput, setClientSecretInput] = useState("");
  const [selectedKind, setSelectedKind] = useState<M2mTokenTestKind>("admin");
  const [signingTokenFormat, setSigningTokenFormat] = useState<SigningTokenFormat>("bearer");

  const adminScopes = computeBackendM2mClientCredentialsScopes(
    allowedScopes || DEFAULT_OIDC_SCOPES,
  );
  const canSignJob = publicAppAllowsSignJob(allowedScopes || DEFAULT_OIDC_SCOPES);
  const { showAdministrative, showRemoteSigning, canUseBearerSigning } =
    resolveM2mPanelFlowFlags({
      flows,
      hasM2mBackend,
      adminScopes,
      canSignJob,
      publicClientId,
      ownerExternalUserId,
    });
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
  const curlSnippets = useMemo(
    () =>
      resolveCurlSnippetsForSelection({
        activeKind,
        useBearerSigning,
        origin,
        m2mClientId: clientId,
        publicClientId,
        adminScopes,
      }),
    [activeKind, adminScopes, clientId, origin, publicClientId, useBearerSigning],
  );
  const tokenCopyLabel = `tokenM2m-${clientId}`;
  const introText = getM2mIntroText(showFlowPicker, showRemoteSigning);
  const signingFormatHint = resolveOwnerSigningFormatHint(
    activeKind,
    canUseBearerSigning,
    signingTokenFormat,
  );
  const actionLabel = getTokenTestActionLabel(activeKind, useBearerSigning, loading);
  const showOwnerKeyAction = activeKind === "owner" && useBearerSigning;
  const showAdminControls = activeKind === "admin";
  const actionDisabled = readOnly || loading || availableFlows.length === 0;

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
      embedded
      onChange={(next) => {
        selectKind("owner");
        setSigningTokenFormat(next);
      }}
    />
  ) : null;

  const runTest = useCallback(async () => {
    if (readOnly) return;
    if (activeKind === "admin" && !effectiveSecret) {
      setError("Enter your client secret to run the administrative token test.");
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    setRawAccessToken(null);
    setSdkToken(null);
    setResultTokenKind(null);
    try {
      const exchange = await executeM2mTokenTest({
        activeKind,
        useBearerSigning,
        adminScopes,
        m2mClientId: clientId,
        publicClientId,
        ownerExternalUserId,
        effectiveSecret,
      });
      setResult(exchange.result);
      setRawAccessToken(exchange.rawAccessToken);
      setSdkToken(exchange.sdkToken);
      setResultTokenKind(exchange.tokenKind);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Token request failed.");
    } finally {
      setLoading(false);
    }
  }, [
    activeKind,
    adminScopes,
    clientId,
    effectiveSecret,
    ownerExternalUserId,
    publicClientId,
    readOnly,
    useBearerSigning,
  ]);

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

      <M2mFlowSelection
        showFlowPicker={showFlowPicker}
        showAdministrative={showAdministrative}
        showRemoteSigning={showRemoteSigning}
        activeKind={activeKind}
        readOnly={readOnly}
        selectKind={selectKind}
        bearerFormatToggle={bearerFormatToggle}
        signingFormatHint={signingFormatHint}
      />

      {showAdminControls ? (
        <M2mAdminSecretField
          clientId={clientId}
          clientSecretInput={clientSecretInput}
          onChange={setClientSecretInput}
          readOnly={readOnly}
        />
      ) : null}

      {showOwnerKeyAction ? (
        <M2mOwnerKeyAction
          actionLabel={actionLabel}
          loading={loading}
          disabled={actionDisabled}
          onRun={runTest}
        />
      ) : null}

      <div className="space-y-2">
        {curlSnippets.map((snippet) => (
          <CurlSnippetDetails
            key={snippet.id}
            snippet={snippet}
            onCopy={onCopy}
            copiedLabel={copiedLabel}
          />
        ))}
      </div>

      {showAdminControls ? (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={runTest}
            disabled={actionDisabled}
            className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-500 disabled:opacity-40 transition-colors"
          >
            {actionLabel}
          </button>
        </div>
      ) : null}

      <M2mTokenTestResult
        error={error}
        result={result}
        rawAccessToken={rawAccessToken}
        sdkToken={sdkToken}
        tokenKind={resultTokenKind}
        onCopy={onCopy}
        copiedLabel={copiedLabel}
        tokenCopyLabel={tokenCopyLabel}
        onDismiss={() => {
          setError(null);
          setResult(null);
          setRawAccessToken(null);
          setSdkToken(null);
          setResultTokenKind(null);
        }}
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
  ownerExternalUserId = null,
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
  const [authTestTab, setAuthTestTab] = useState<"remote" | "admin">("remote");
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
  const showRemoteSigningTab =
    !isM2MOnly &&
    Boolean(clientId?.startsWith("app_")) &&
    publicAppAllowsSignJob(allowedScopes ?? DEFAULT_OIDC_SCOPES);
  const showAdminAccessTab = Boolean(backendHelper?.clientId);
  const showAuthTestSection = showRemoteSigningTab || showAdminAccessTab;
  const effectiveAuthTestTab = resolveEffectiveAuthTestTab(
    authTestTab,
    showAdminAccessTab,
    showRemoteSigningTab,
  );

  useEffect(() => {
    if (authTestTab === "admin" && !showAdminAccessTab && showRemoteSigningTab) {
      setAuthTestTab("remote");
    }
  }, [authTestTab, showAdminAccessTab, showRemoteSigningTab]);

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

      {showAuthTestSection ? (
        <div className="p-4 rounded-xl border border-zinc-800 bg-zinc-900/30 space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-zinc-200">Test authentication</h3>
              <p className="text-xs text-zinc-500 mt-1">
                {effectiveAuthTestTab === "remote"
                  ? "Bearer API key for direct signing, or mint + exchange for a signer JWT. Device code login remains the end-user path."
                  : "Client-credentials token exchange with the Backend helper for Builder APIs, user provisioning, and device approval."}
              </p>
            </div>
            {showRemoteSigningTab && showAdminAccessTab ? (
              <div
                className="flex shrink-0 items-center gap-1 self-start rounded-lg bg-black/20 p-0.5"
                role="tablist"
                aria-label="Authentication test type"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={effectiveAuthTestTab === "remote"}
                  onClick={() => setAuthTestTab("remote")}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                    effectiveAuthTestTab === "remote"
                      ? "bg-emerald-500/15 text-emerald-400 shadow-[inset_0_0_0_1px_rgba(52,211,153,0.25)]"
                      : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]"
                  }`}
                >
                  Remote signing
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={effectiveAuthTestTab === "admin"}
                  onClick={() => setAuthTestTab("admin")}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                    effectiveAuthTestTab === "admin"
                      ? "bg-cyan-500/15 text-cyan-300 shadow-[inset_0_0_0_1px_rgba(34,211,238,0.25)]"
                      : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]"
                  }`}
                >
                  Administrative
                </button>
              </div>
            ) : null}
          </div>

          {effectiveAuthTestTab === "remote" && showRemoteSigningTab && clientId ? (
            <M2mTokenTestPanel
              clientId={clientId}
              publicClientId={clientId}
              ownerExternalUserId={ownerExternalUserId}
              generatedSecret={null}
              allowedScopes={allowedScopes ?? DEFAULT_OIDC_SCOPES}
              readOnly={readOnly}
              origin={browserOrigin}
              onCopy={copyToClipboard}
              copiedLabel={copied}
              showTopBorder={false}
              hasM2mBackend={false}
              flows={["owner"]}
            />
          ) : null}

          {effectiveAuthTestTab === "admin" && backendHelper?.clientId ? (
            <M2mTokenTestPanel
              clientId={backendHelper.clientId}
              publicClientId={clientId?.startsWith("app_") ? clientId : null}
              ownerExternalUserId={ownerExternalUserId}
              generatedSecret={m2mSecretForTests}
              allowedScopes={allowedScopes ?? DEFAULT_OIDC_SCOPES}
              readOnly={readOnly}
              origin={browserOrigin}
              onCopy={copyToClipboard}
              copiedLabel={copied}
              showTopBorder={false}
              hasM2mBackend
              flows={["admin"]}
            />
          ) : null}
        </div>
      ) : null}

      {isM2MOnly && clientId ? (
        <div className="space-y-4 p-5 rounded-xl border border-zinc-800 bg-zinc-900/30">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-cyan-500" />
            <h3 className="text-sm font-semibold text-zinc-200">M2M token exchange</h3>
          </div>
          <M2mTokenTestPanel
            clientId={clientId}
            publicClientId={clientId.startsWith("app_") ? clientId : null}
            ownerExternalUserId={ownerExternalUserId}
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

