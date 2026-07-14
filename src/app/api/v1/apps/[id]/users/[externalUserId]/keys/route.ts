import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { authenticateAppClient, authenticateRequestAsync, hasScope } from "@/lib/auth";
import { db } from "@/db/index";
import { appUsers } from "@/db/schema";
import {
  canEditProviderApp,
  getAuthorizedProviderApp,
  getProviderApp,
  appEditForbiddenResponse,
} from "@/lib/provider-apps";
import { createCorrelationId, writeAuditLog } from "@/lib/audit";
import {
  createAppUserApiKey,
  listAppUserApiKeys,
  revokeAppUserApiKey,
} from "@/lib/app-api-keys";
import { createLivepeerPythonSdkToken } from "@/lib/livepeer-python-sdk-token";

async function canAccessUserKeys(request: NextRequest, clientId: string) {
  const app = await getProviderApp(clientId);
  if (!app) {
    return null;
  }

  const providerAuth = await getAuthorizedProviderApp(clientId, request);
  if (providerAuth) {
    return {
      app: providerAuth.app,
      actorUserId: providerAuth.userId,
      canEdit: await canEditProviderApp(providerAuth),
    };
  }

  const bearer = await authenticateRequestAsync(request);
  if (bearer?.appId === clientId && hasScope(bearer.scopes, "users:write")) {
    return { app, actorUserId: bearer.userId, canEdit: true };
  }

  const clientAuth = await authenticateAppClient(request);
  if (clientAuth?.appId === clientId && hasScope(clientAuth.scopes, "users:write")) {
    return { app, actorUserId: null, canEdit: true };
  }

  return null;
}

async function resolveAppUser(developerAppId: string, externalUserId: string) {
  const rows = await db
    .select()
    .from(appUsers)
    .where(
      and(
        eq(appUsers.clientId, developerAppId),
        eq(appUsers.externalUserId, externalUserId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; externalUserId: string }> },
) {
  const { id: clientId, externalUserId: rawExternalUserId } = await params;
  const externalUserId = decodeURIComponent(rawExternalUserId);
  const access = await canAccessUserKeys(request, clientId);
  if (!access) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const appUser = await resolveAppUser(access.app.id, externalUserId);
  if (appUser?.status !== "active") {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const keys = await listAppUserApiKeys({
    developerAppId: access.app.id,
    appUserId: appUser.id,
  });

  return NextResponse.json({
    clientId,
    externalUserId,
    keys,
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; externalUserId: string }> },
) {
  const { id: clientId, externalUserId: rawExternalUserId } = await params;
  const externalUserId = decodeURIComponent(rawExternalUserId);
  const access = await canAccessUserKeys(request, clientId);
  if (!access) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!access.canEdit) {
    return appEditForbiddenResponse();
  }

  const appUser = await resolveAppUser(access.app.id, externalUserId);
  if (appUser?.status !== "active") {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));
  const label = typeof body.label === "string" ? body.label : null;

  const created = await createAppUserApiKey({
    developerAppId: access.app.id,
    appUserId: appUser.id,
    publicClientId: clientId,
    label,
  });

  const correlationId = createCorrelationId();
  await writeAuditLog({
    clientId: access.app.id,
    actorUserId: access.actorUserId,
    action: "api_key_created",
    status: "success",
    correlationId,
    metadata: {
      keyId: created.id,
      externalUserId,
      label: created.label,
      appUserId: appUser.id,
    },
  });

  const sdkToken = createLivepeerPythonSdkToken({ apiKey: created.apiKey });

  return NextResponse.json(
    {
      clientId,
      externalUserId,
      apiKey: created.apiKey,
      sdkToken,
      id: created.id,
      prefix: created.prefix,
      suffix: created.suffix,
      label: created.label,
      createdAt: created.createdAt,
      message:
        "Store this API key securely. It will not be shown again. Use the full app_<24hex>_<secret> value as Authorization: Bearer <token> for the remote signer, or use sdkToken as --token with livepeer-python-sdk.",
      correlation_id: correlationId,
    },
    { status: 201 },
  );
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; externalUserId: string }> },
) {
  const { id: clientId, externalUserId: rawExternalUserId } = await params;
  const externalUserId = decodeURIComponent(rawExternalUserId);
  const access = await canAccessUserKeys(request, clientId);
  if (!access) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!access.canEdit) {
    return appEditForbiddenResponse();
  }

  const keyId = request.nextUrl.searchParams.get("keyId")?.trim();
  if (!keyId) {
    return NextResponse.json({ error: "keyId is required" }, { status: 400 });
  }

  const appUser = await resolveAppUser(access.app.id, externalUserId);
  if (!appUser) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const revoked = await revokeAppUserApiKey({
    developerAppId: access.app.id,
    appUserId: appUser.id,
    keyId,
  });
  if (!revoked) {
    return NextResponse.json({ error: "Key not found" }, { status: 404 });
  }

  const correlationId = createCorrelationId();
  await writeAuditLog({
    clientId: access.app.id,
    actorUserId: access.actorUserId,
    action: "api_key_revoked",
    status: "success",
    correlationId,
    metadata: { keyId, externalUserId },
  });

  return NextResponse.json({ success: true, correlation_id: correlationId });
}
