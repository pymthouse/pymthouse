import { DEFAULT_OIDC_SCOPES, OIDC_SCOPES } from "@/platform/oidc/scopes";

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

type Ok<T> = { ok: true; value: T };
type Err = { ok: false; status: 400; body: { error: string } };

export interface ParsedAppCreateInput {
  name: string;
  developerName: string | null;
  websiteUrl: string | null;
  backendDeviceHelper: boolean;
  clientUpdates: {
    redirectUris?: string[];
    tokenEndpointAuthMethod?: "none" | "client_secret_post" | "client_secret_basic";
    allowedScopes?: string;
    grantTypes?: string[];
  };
}

export function parseAppCreateInput(body: unknown): Ok<ParsedAppCreateInput> | Err {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, body: { error: "App name is required" } };
  }

  const record = body as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name) {
    return { ok: false, status: 400, body: { error: "App name is required" } };
  }

  const clientUpdates: ParsedAppCreateInput["clientUpdates"] = {};
  if (Array.isArray(record.redirectUris) && record.redirectUris.length > 0) {
    const redirectUris = record.redirectUris.filter(
      (uri): uri is string => typeof uri === "string" && uri.trim().length > 0,
    );
    if (redirectUris.length > 0) {
      clientUpdates.redirectUris = redirectUris.map((uri) => uri.trim());
    }
  }
  if (
    record.tokenEndpointAuthMethod === "none" ||
    record.tokenEndpointAuthMethod === "client_secret_post" ||
    record.tokenEndpointAuthMethod === "client_secret_basic"
  ) {
    clientUpdates.tokenEndpointAuthMethod = record.tokenEndpointAuthMethod;
  }
  if (typeof record.allowedScopes === "string" && record.allowedScopes.trim()) {
    const validScopeValues = new Set(OIDC_SCOPES.map((scope) => scope.value));
    const filtered = record.allowedScopes
      .split(/[,\s]+/)
      .filter((scope) => scope && validScopeValues.has(scope))
      .join(" ");
    clientUpdates.allowedScopes = filtered || DEFAULT_OIDC_SCOPES;
  }
  if (Array.isArray(record.grantTypes) && record.grantTypes.length > 0) {
    const grantTypes = record.grantTypes.filter(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
    if (grantTypes.length > 0) {
      clientUpdates.grantTypes = grantTypes;
    }
  }
  if (
    record.deviceThirdPartyInitiateLogin === true &&
    typeof record.initiateLoginUri === "string" &&
    record.initiateLoginUri.trim() &&
    (clientUpdates.grantTypes ?? ["authorization_code", "refresh_token"]).includes(DEVICE_CODE_GRANT)
  ) {
    const allowedScopes = (clientUpdates.allowedScopes ?? DEFAULT_OIDC_SCOPES)
      .split(/[,\s]+/)
      .filter(Boolean);
    if (!allowedScopes.includes("users:token")) {
      clientUpdates.allowedScopes = [...allowedScopes, "users:token"].join(" ");
    }
  }

  return {
    ok: true,
    value: {
      name,
      developerName: typeof record.developerName === "string" ? record.developerName : null,
      websiteUrl: typeof record.websiteUrl === "string" ? record.websiteUrl : null,
      backendDeviceHelper: record.backendDeviceHelper === true,
      clientUpdates,
    },
  };
}
