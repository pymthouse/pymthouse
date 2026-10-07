import { DEFAULT_OIDC_SCOPES, OIDC_SCOPES } from "@/platform/oidc/scopes";

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export interface ExistingOidcClientShape {
  allowedScopes: string;
  grantTypes: string;
  initiateLoginUri: string | null;
  deviceThirdPartyInitiateLogin: number;
}

export interface ParsedAppCoreUpdate {
  appUpdates: Record<string, unknown>;
  clientUpdates: {
    displayName?: string;
    redirectUris?: string[];
    tokenEndpointAuthMethod?: "none" | "client_secret_post" | "client_secret_basic";
    allowedScopes?: string;
    grantTypes?: string[];
  };
  backendDeviceHelper: boolean;
}

export function parseAppCoreUpdate(
  body: Record<string, unknown>,
  existingClient: ExistingOidcClientShape | null,
): ParsedAppCoreUpdate {
  const now = new Date().toISOString();
  const appUpdates: Record<string, unknown> = { updatedAt: now };
  const appFields = ["name", "description", "developerName", "websiteUrl"] as const;

  for (const field of appFields) {
    if (body[field] !== undefined) {
      appUpdates[field] = body[field];
    }
  }

  const clientUpdates: ParsedAppCoreUpdate["clientUpdates"] = {};
  if (typeof body.name === "string" && body.name.trim()) {
    clientUpdates.displayName = body.name;
  }
  if (Array.isArray(body.redirectUris)) {
    clientUpdates.redirectUris = body.redirectUris as string[];
  }
  if (
    body.tokenEndpointAuthMethod === "none" ||
    body.tokenEndpointAuthMethod === "client_secret_post" ||
    body.tokenEndpointAuthMethod === "client_secret_basic"
  ) {
    clientUpdates.tokenEndpointAuthMethod = body.tokenEndpointAuthMethod;
  }
  if (body.allowedScopes !== undefined) {
    const validScopeValues = new Set(OIDC_SCOPES.map((scope) => scope.value));
    const filtered = String(body.allowedScopes)
      .split(/[,\s]+/)
      .filter((scope) => scope && validScopeValues.has(scope))
      .join(" ");
    clientUpdates.allowedScopes = filtered || DEFAULT_OIDC_SCOPES;
  }
  if (Array.isArray(body.grantTypes)) {
    clientUpdates.grantTypes = body.grantTypes as string[];
  }

  if (existingClient) {
    const nextGrantTypes =
      clientUpdates.grantTypes ?? existingClient.grantTypes.split(",").filter(Boolean);
    const nextInitiateLoginUri = existingClient.initiateLoginUri?.trim();
    const nextDeviceThirdPartyInitiateLogin = existingClient.deviceThirdPartyInitiateLogin === 1;
    if (
      nextDeviceThirdPartyInitiateLogin &&
      nextInitiateLoginUri &&
      nextGrantTypes.includes(DEVICE_CODE_GRANT)
    ) {
      const allowedScopes = (clientUpdates.allowedScopes ?? existingClient.allowedScopes)
        .split(/[,\s]+/)
        .filter(Boolean);
      if (!allowedScopes.includes("users:token")) {
        clientUpdates.allowedScopes = [...allowedScopes, "users:token"].join(" ");
      }
    }
  }

  return {
    appUpdates,
    clientUpdates,
    backendDeviceHelper: body.backendDeviceHelper === true,
  };
}

export function hasClientConfigUpdates(
  updates: ParsedAppCoreUpdate["clientUpdates"],
): boolean {
  return Object.keys(updates).length > 0;
}
