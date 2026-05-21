/**
 * Shared device-code approval logic for interactive UI and Builder API.
 */

import { SqliteAdapter } from "@/lib/oidc/adapter";
import { getProvider } from "@/lib/oidc/provider";
import { getIssuer } from "@/lib/oidc/issuer-urls";

export type DeviceApprovalFailure = {
  ok: false;
  error: string;
  description: string;
  status: number;
};

export type DeviceApprovalSuccess = { ok: true };

function isDeviceCodeBound(payload: Record<string, unknown>): boolean {
  const accountId = payload.accountId;
  const grantId = payload.grantId;
  if (typeof accountId === "string" && accountId.length > 0) {
    return true;
  }
  if (typeof grantId === "string" && grantId.length > 0) {
    return true;
  }
  return false;
}

/**
 * Bind a pending device code to an OIDC account and grant scopes.
 * `oidcClientId` must match the client that requested the device code.
 */
export async function approveDeviceCodeForAccount(
  normalizedUserCode: string,
  oidcClientId: string,
  accountId: string,
): Promise<DeviceApprovalSuccess | DeviceApprovalFailure> {
  const adapter = new SqliteAdapter("DeviceCode");
  const deviceCode = await adapter.findByUserCode(normalizedUserCode);

  if (!deviceCode) {
    return {
      ok: false,
      error: "invalid_grant",
      description: "Invalid, expired, or already used device code",
      status: 400,
    };
  }

  if (deviceCode.consumed) {
    return {
      ok: false,
      error: "invalid_grant",
      description: "Device code already used",
      status: 400,
    };
  }

  if (deviceCode.exp && deviceCode.exp < Math.floor(Date.now() / 1000)) {
    return {
      ok: false,
      error: "expired_token",
      description: "The device code has expired",
      status: 400,
    };
  }

  const boundClient =
    typeof deviceCode.clientId === "string"
      ? deviceCode.clientId
      : typeof deviceCode.params === "object" &&
          deviceCode.params !== null &&
          typeof (deviceCode.params as Record<string, unknown>).client_id === "string"
        ? ((deviceCode.params as Record<string, unknown>).client_id as string)
        : null;

  if (!boundClient || boundClient !== oidcClientId) {
    return {
      ok: false,
      error: "invalid_grant",
      description: "Device code does not match this client",
      status: 400,
    };
  }

  const params =
    typeof deviceCode.params === "object" && deviceCode.params !== null
      ? (deviceCode.params as Record<string, unknown>)
      : null;
  const resourceFromParams = params?.resource;
  const resource =
    typeof resourceFromParams === "string" && resourceFromParams.length > 0
      ? resourceFromParams
      : typeof deviceCode.resource === "string" && deviceCode.resource.length > 0
        ? deviceCode.resource
        : getIssuer();

  const scope =
    typeof deviceCode.scope === "string"
      ? deviceCode.scope
      : params && typeof params.scope === "string"
        ? params.scope
        : "";

  if (typeof deviceCode.jti !== "string" || deviceCode.jti.length === 0) {
    return {
      ok: false,
      error: "invalid_grant",
      description: "Invalid, expired, or already used device code",
      status: 400,
    };
  }

  const latest = await adapter.find(deviceCode.jti);
  if (!latest) {
    return {
      ok: false,
      error: "invalid_grant",
      description: "Invalid, expired, or already used device code",
      status: 400,
    };
  }

  if (isDeviceCodeBound(latest as Record<string, unknown>)) {
    return { ok: true };
  }

  const provider = await getProvider();
  const grant = new provider.Grant();
  grant.clientId = oidcClientId;
  grant.accountId = accountId;
  if (scope) {
    grant.addOIDCScope(scope);
    grant.addResourceScope(resource, scope);
  }
  const newGrantId = await grant.save();

  const now = Math.floor(Date.now() / 1000);
  const expiresIn = deviceCode.exp ? Math.max(deviceCode.exp - now, 1) : 600;

  let bound: boolean;
  try {
    bound = await adapter.bindDeviceApprovalIfUnbound(
      deviceCode.jti,
      {
        ...latest,
        accountId,
        grantId: newGrantId,
        scope,
        resource,
        authTime: now,
        acr: typeof latest.acr === "string" ? latest.acr : "urn:pmth:session",
        amr: Array.isArray(latest.amr) ? latest.amr : ["pwd"],
        error: undefined,
        errorDescription: undefined,
      },
      expiresIn,
    );
  } catch (err) {
    const after = await adapter.find(deviceCode.jti);
    const payloadGrantId =
      after && typeof (after as Record<string, unknown>).grantId === "string"
        ? ((after as Record<string, unknown>).grantId as string)
        : "";
    if (payloadGrantId !== newGrantId) {
      await grant.destroy();
    }
    throw err;
  }

  if (!bound) {
    await grant.destroy();
    return { ok: true };
  }

  return { ok: true };
}
