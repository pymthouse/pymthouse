"use client";

import { computeBackendM2mAllowedScopes } from "@/platform/oidc/backend-m2m-scopes";
import { getScopeDefinition, OIDC_SCOPES } from "@/platform/oidc/scopes";

export interface AppTestingModelInput {
  origin: string;
  clientId: string | null;
  grantTypes: string[];
  redirectUris: string[];
  allowedScopes: string;
  backendHelper: { clientId: string; hasSecret: boolean } | null;
  selectedRedirectUri: string;
}

export function getDefaultRedirectUri(redirectUris: string[]) {
  return redirectUris.find((uri) => /^https?:\/\//i.test(uri)) ?? redirectUris[0] ?? "";
}

function getEffectiveScopes(allowedScopes: string) {
  const validScopeValues = new Set(OIDC_SCOPES.map((scope) => scope.value));
  return allowedScopes
    .split(/\s+/)
    .filter((scope) => scope && validScopeValues.has(scope))
    .join(" ");
}

function getSelectedScopeLabels(effectiveScopes: string) {
  return effectiveScopes
    .split(/\s+/)
    .filter(Boolean)
    .map((scope) => getScopeDefinition(scope)?.label || scope);
}

function buildAuthorizationTestUrl({
  origin,
  clientId,
  selectedRedirectUri,
  effectiveScopes,
}: {
  origin: string;
  clientId: string | null;
  selectedRedirectUri: string;
  effectiveScopes: string;
}) {
  if (!clientId || !selectedRedirectUri || !origin) return null;
  return `${origin}/api/v1/oidc/authorize?${new URLSearchParams({
    client_id: clientId,
    redirect_uri: selectedRedirectUri,
    response_type: "code",
    scope: effectiveScopes,
    state: "test",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
  }).toString()}`;
}

function buildClientCredentialsCurlSnippet({
  origin,
  clientId,
  allowedScopes,
}: {
  origin: string;
  clientId: string | null;
  allowedScopes: string;
}) {
  if (!clientId) return "";
  const validScopeValues = new Set(OIDC_SCOPES.map((scope) => scope.value));
  const scopesForSnippet =
    allowedScopes
      .split(/\s+/)
      .filter((scope) => scope && validScopeValues.has(scope) && scope !== "openid")
      .join(" ") || "YOUR_CONFIGURED_SCOPES";

  return `curl -X POST ${origin}/api/v1/oidc/token \\
  -H "Content-Type: application/x-www-form-urlencoded" \\
  -d "grant_type=client_credentials" \\
  -d "client_id=${clientId}" \\
  -d "client_secret=YOUR_CLIENT_SECRET" \\
  -d "scope=${scopesForSnippet}"`;
}

function buildBackendHelperCurlSnippet({
  origin,
  backendHelper,
  allowedScopes,
}: {
  origin: string;
  backendHelper: { clientId: string; hasSecret: boolean } | null;
  allowedScopes: string;
}) {
  if (!backendHelper?.clientId) return "";
  const backendHelperScopes = computeBackendM2mAllowedScopes(allowedScopes);

  return `curl -X POST ${origin}/api/v1/oidc/token \\
  -H "Content-Type: application/x-www-form-urlencoded" \\
  -d "grant_type=client_credentials" \\
  -d "client_id=${backendHelper.clientId}" \\
  -d "client_secret=YOUR_CLIENT_SECRET" \\
  -d "scope=${backendHelperScopes}"`;
}

export function buildAppTestingModel(input: AppTestingModelInput) {
  const hasAuthCodeFlow = input.grantTypes.includes("authorization_code");
  const isM2MOnly = input.grantTypes.includes("client_credentials") && !hasAuthCodeFlow;
  const discoveryUrl = input.origin ? `${input.origin}/.well-known/openid-configuration` : "";
  const effectiveScopes = getEffectiveScopes(input.allowedScopes);
  const selectedScopes = getSelectedScopeLabels(effectiveScopes);
  const testUrl = buildAuthorizationTestUrl({
    origin: input.origin,
    clientId: input.clientId,
    selectedRedirectUri: input.selectedRedirectUri,
    effectiveScopes,
  });
  const m2mClientIdForSnippet = isM2MOnly ? input.clientId : input.backendHelper?.clientId ?? null;

  return {
    hasAuthCodeFlow,
    isM2MOnly,
    discoveryUrl,
    selectedScopes,
    testUrl,
    m2mCurlSnippet: buildClientCredentialsCurlSnippet({
      origin: input.origin,
      clientId: m2mClientIdForSnippet,
      allowedScopes: input.allowedScopes,
    }),
    backendHelperCurlSnippet: buildBackendHelperCurlSnippet({
      origin: input.origin,
      backendHelper: input.backendHelper,
      allowedScopes: input.allowedScopes,
    }),
  };
}
