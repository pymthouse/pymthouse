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

function approvalFailure(
  error: string,
  description: string,
  status = 400,
): DeviceApprovalFailure {
  return { ok: false, error, description, status };
}

function extractBoundClientId(deviceCode: Record<string, unknown>): string | null {
  if (typeof deviceCode.clientId === "string") {
    return deviceCode.clientId;
  }
  if (
    typeof deviceCode.params === "object" &&
    deviceCode.params !== null &&
    typeof (deviceCode.params as Record<string, unknown>).client_id === "string"
  ) {
    return (deviceCode.params as Record<string, unknown>).client_id as string;
  }
  return null;
}

function resolveDeviceResourceAndScope(deviceCode: Record<string, unknown>): {
  resource: string;
  scope: string;
} {
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

  return { resource, scope };
}

function validatePendingDeviceCode(
  deviceCode: Record<string, unknown> | null | undefined,
  oidcClientId: string,
): DeviceApprovalFailure | null {
  if (!deviceCode) {
    return approvalFailure(
      "invalid_grant",
      "Invalid, expired, or already used device code",
    );
  }

  if (deviceCode.consumed) {
    return approvalFailure("invalid_grant", "Device code already used");
  }

  if (
    deviceCode.exp &&
    typeof deviceCode.exp === "number" &&
    deviceCode.exp < Math.floor(Date.now() / 1000)
  ) {
    return approvalFailure("expired_token", "The device code has expired");
  }

  const boundClient = extractBoundClientId(deviceCode);
  if (!boundClient || boundClient !== oidcClientId) {
    return approvalFailure(
      "invalid_grant",
      "Device code does not match this client",
    );
  }

  if (typeof deviceCode.jti !== "string" || deviceCode.jti.length === 0) {
    return approvalFailure(
      "invalid_grant",
      "Invalid, expired, or already used device code",
    );
  }

  return null;
}

async function bindDeviceApproval(
  adapter: InstanceType<typeof SqliteAdapter>,
  deviceCode: Record<string, unknown>,
  latest: Record<string, unknown>,
  oidcClientId: string,
  accountId: string,
  resource: string,
  scope: string,
): Promise<DeviceApprovalSuccess> {
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
  const expiresIn = deviceCode.exp
    ? Math.max((deviceCode.exp as number) - now, 1)
    : 600;

  let bound: boolean;
  try {
    bound = await adapter.bindDeviceApprovalIfUnbound(
      deviceCode.jti as string,
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
    const after = await adapter.find(deviceCode.jti as string);
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
  }

  return { ok: true };
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

  const earlyFailure = validatePendingDeviceCode(
    deviceCode as Record<string, unknown> | null | undefined,
    oidcClientId,
  );
  if (earlyFailure) return earlyFailure;

  const code = deviceCode as Record<string, unknown>;
  const { resource, scope } = resolveDeviceResourceAndScope(code);

  const latest = await adapter.find(code.jti as string);
  if (!latest) {
    return approvalFailure(
      "invalid_grant",
      "Invalid, expired, or already used device code",
    );
  }

  if (isDeviceCodeBound(latest as Record<string, unknown>)) {
    return { ok: true };
  }

  return bindDeviceApproval(
    adapter,
    code,
    latest as Record<string, unknown>,
    oidcClientId,
    accountId,
    resource,
    scope,
  );
}
