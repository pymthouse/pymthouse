import type { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { SqliteAdapter } from "@/domains/oidc-platform/runtime/adapter";
import { getClient } from "@/domains/oidc-platform/runtime/clients";
import { approveDeviceCodeForAccount } from "./device-approval";
import { normalizeUserCode } from "@/platform/oidc/device";
import { resolveAppBrandingByClientId } from "./branding";
import { checkAppAccess } from "./app-access";
import { authOptions } from "@/platform/auth/next-auth-options";
import { getDeviceVerificationClientPolicy } from "../repo/device-verification";
import {
  deviceVerificationError,
  parseDeviceVerificationInput,
} from "../service/device-verification";

export async function handleDeviceVerificationRequest(
  request: NextRequest,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return deviceVerificationError("unauthorized", "You must be signed in", 401);
  }
  const userId = (session.user as Record<string, unknown>).id as string;
  if (!userId) {
    return deviceVerificationError("unauthorized", "You must be signed in", 401);
  }

  const parsed = parseDeviceVerificationInput(await request.json());
  if (!parsed.ok) {
    return { status: parsed.status, body: parsed.body };
  }

  const adapter = new SqliteAdapter("DeviceCode");
  const normalizedUserCode = normalizeUserCode(parsed.userCode);
  const deviceCode = await adapter.findByUserCode(normalizedUserCode);

  if (!deviceCode) {
    return deviceVerificationError(
      "invalid_grant",
      "Invalid, expired, or already used device code",
    );
  }
  if (deviceCode.consumed) {
    return deviceVerificationError("invalid_grant", "Device code already used");
  }
  if (deviceCode.exp && deviceCode.exp < Math.floor(Date.now() / 1000)) {
    return deviceVerificationError("expired_token", "The device code has expired");
  }

  if (parsed.action === "lookup") {
    const clientId = deviceCode.clientId || deviceCode.params?.client_id;
    const client = typeof clientId === "string" ? await getClient(clientId) : null;
    const branding =
      typeof clientId === "string" ? await resolveAppBrandingByClientId(clientId) : null;
    const scope =
      typeof deviceCode.scope === "string"
        ? deviceCode.scope
        : typeof deviceCode.params?.scope === "string"
          ? deviceCode.params.scope
          : "";
    let impliedDeviceConsent = false;
    if (typeof clientId === "string") {
      const policy = await getDeviceVerificationClientPolicy(clientId);
      impliedDeviceConsent =
        policy?.deviceThirdPartyInitiateLogin === 1 && !!policy?.clientSecretHash;
    }

    return {
      status: 200,
      body: {
        client_name: client?.displayName || clientId || "Unknown Application",
        scopes: scope.split(" ").filter(Boolean),
        implied_device_consent: impliedDeviceConsent,
        branding: branding
          ? {
              mode: branding.mode,
              displayName: branding.displayName,
              logoUrl: branding.logoUrl,
              primaryColor: branding.primaryColor,
            }
          : null,
      },
    };
  }

  if (parsed.action === "approve") {
    const clientId = deviceCode.clientId || deviceCode.params?.client_id;
    if (typeof clientId !== "string" || !clientId) {
      return deviceVerificationError(
        "server_error",
        "Device code is missing client binding",
        500,
      );
    }

    const accessCheck = await checkAppAccess(clientId, userId);
    if (!accessCheck.allowed) {
      return deviceVerificationError(
        "access_denied",
        accessCheck.reason || "You do not have access to this application",
        403,
      );
    }

    const approved = await approveDeviceCodeForAccount(normalizedUserCode, clientId, userId);
    if (!approved.ok) {
      return deviceVerificationError(
        approved.error,
        approved.description,
        approved.status,
      );
    }

    return { status: 200, body: { status: "authorized" } };
  }

  const now = Math.floor(Date.now() / 1000);
  const expiresIn = deviceCode.exp ? Math.max(deviceCode.exp - now, 1) : 600;
  await adapter.upsert(
    deviceCode.jti!,
    {
      ...deviceCode,
      error: "access_denied",
      errorDescription: "The user denied the authorization request",
    },
    expiresIn,
  );

  return { status: 200, body: { status: "denied" } };
}
