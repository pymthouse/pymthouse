import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/next-auth-options";
import { db } from "@/db/index";
import { developerApps, oidcClients, providerAdmins } from "@/db/schema";
import { eq, inArray } from "drizzle-orm";
import {
  createAppClient,
  ensureM2mBackendClient,
  updateClientConfig,
} from "@/lib/oidc/clients";
import { resetProvider } from "@/lib/oidc/provider";
import { DEFAULT_OIDC_SCOPES, OIDC_SCOPES } from "@/lib/oidc/scopes";
import { ensureProviderAdminMembership } from "@/lib/provider-apps";
import { isHostedAdminClientAvailable } from "@/lib/openmeter/admin-client";
import { syncPlanToOpenMeter } from "@/lib/openmeter/plans-sync";
import { getOrCreateNetworkDefaultPlan } from "@/lib/network-default-plan";
import { getOrCreateStarterPlan } from "@/lib/starter-default-plan";

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = (session.user as Record<string, unknown>).id as string;
  if (!userId) {
    return NextResponse.json({ error: "Invalid session" }, { status: 401 });
  }

  const memberships = await db
    .select({ clientId: providerAdmins.clientId })
    .from(providerAdmins)
    .where(eq(providerAdmins.userId, userId));

  const memberIds = memberships.map((membership) => membership.clientId);
  const ownedApps = await db
    .select({
      id: oidcClients.clientId,
      name: developerApps.name,
      subtitle: developerApps.subtitle,
      category: developerApps.category,
      status: developerApps.status,
      logoLightUrl: developerApps.logoLightUrl,
      brandingMode: developerApps.brandingMode,
      customLoginEnabled: developerApps.customLoginEnabled,
      customLoginDomain: developerApps.customLoginDomain,
      createdAt: developerApps.createdAt,
      updatedAt: developerApps.updatedAt,
      clientId: oidcClients.clientId,
    })
    .from(developerApps)
    .leftJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(eq(developerApps.ownerId, userId));

  const memberApps =
    memberIds.length === 0
      ? []
      : await db
        .select({
          id: oidcClients.clientId,
          name: developerApps.name,
          subtitle: developerApps.subtitle,
          category: developerApps.category,
          status: developerApps.status,
          logoLightUrl: developerApps.logoLightUrl,
          brandingMode: developerApps.brandingMode,
          customLoginEnabled: developerApps.customLoginEnabled,
          customLoginDomain: developerApps.customLoginDomain,
          createdAt: developerApps.createdAt,
          updatedAt: developerApps.updatedAt,
          clientId: oidcClients.clientId,
        })
        .from(developerApps)
        .leftJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
        .where(inArray(developerApps.id, memberIds));

  const apps = [...ownedApps, ...memberApps].filter(
    (app, index, rows) => rows.findIndex((row) => row.id === app.id) === index,
  );

  return NextResponse.json({ apps });
}

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = (session.user as Record<string, unknown>).id as string;
  if (!userId) {
    return NextResponse.json({ error: "Invalid session" }, { status: 401 });
  }

  const body = await request.json();
  const { name } = body;

  if (!name || typeof name !== "string" || name.trim().length === 0) {
    return NextResponse.json(
      { error: "App name is required" },
      { status: 400 }
    );
  }

  const { id: oidcRowId, clientId } = await createAppClient(name.trim());

  const clientUpdates: Parameters<typeof updateClientConfig>[1] = {};
  const rawRedirectUris = body.redirectUris;
  if (Array.isArray(rawRedirectUris) && rawRedirectUris.length > 0) {
    const redirectUris = rawRedirectUris.filter(
      (u: unknown): u is string => typeof u === "string" && u.trim().length > 0,
    );
    if (redirectUris.length > 0) {
      clientUpdates.redirectUris = redirectUris.map((u) => u.trim());
    }
  }
  if (
    typeof body.tokenEndpointAuthMethod === "string" &&
    ["none", "client_secret_post", "client_secret_basic"].includes(body.tokenEndpointAuthMethod)
  ) {
    clientUpdates.tokenEndpointAuthMethod = body.tokenEndpointAuthMethod;
  }
  if (typeof body.allowedScopes === "string" && body.allowedScopes.trim()) {
    const validScopeValues = new Set(OIDC_SCOPES.map((s) => s.value));
    const filtered = body.allowedScopes
      .split(/[,\s]+/)
      .filter((s: string) => s && validScopeValues.has(s))
      .join(" ");
    clientUpdates.allowedScopes = filtered || DEFAULT_OIDC_SCOPES;
  }
  if (Array.isArray(body.grantTypes) && body.grantTypes.length > 0) {
    const grantTypes = body.grantTypes.filter(
      (v: unknown): v is string => typeof v === "string" && v.trim().length > 0,
    );
    if (grantTypes.length > 0) {
      clientUpdates.grantTypes = grantTypes;
    }
  }
  if (
    body.deviceThirdPartyInitiateLogin === true &&
    typeof body.initiateLoginUri === "string" &&
    body.initiateLoginUri.trim() &&
    (clientUpdates.grantTypes ?? ["authorization_code", "refresh_token"]).includes(DEVICE_CODE_GRANT)
  ) {
    const allowedScopes = (clientUpdates.allowedScopes ?? DEFAULT_OIDC_SCOPES)
      .split(/[,\s]+/)
      .filter(Boolean);
    if (!allowedScopes.includes("users:token")) {
      clientUpdates.allowedScopes = [...allowedScopes, "users:token"].join(" ");
    }
  }
  if (Object.keys(clientUpdates).length > 0) {
    await updateClientConfig(clientId, clientUpdates);
  }

  const appId = clientId;
  const now = new Date().toISOString();

  try {
    await db.transaction(async (tx) => {
      await tx.insert(developerApps).values({
        id: appId,
        ownerId: userId,
        oidcClientId: oidcRowId,
        name: name.trim(),
        developerName: body.developerName || null,
        websiteUrl: body.websiteUrl || null,
        status: "draft", // Apps start as draft and require admin approval
        createdAt: now,
        updatedAt: now,
      });
      await getOrCreateNetworkDefaultPlan(appId, tx);
      await getOrCreateStarterPlan(appId, tx);
    });
  } catch (err) {
    console.error("Failed to create app with default plans:", err);
    return NextResponse.json(
      { error: "Failed to create app" },
      { status: 500 },
    );
  }

  if (body.backendDeviceHelper === true) {
    await ensureM2mBackendClient({
      appInternalId: appId,
      appDisplayName: name.trim(),
    });
  }

  if (isHostedAdminClientAvailable()) {
    try {
      const starter = await getOrCreateStarterPlan(appId);
      await syncPlanToOpenMeter(starter.id);
    } catch (err) {
      console.error("Starter plan OpenMeter sync failed for new app:", err);
    }
  }

  resetProvider();
  await ensureProviderAdminMembership(userId, appId);

  return NextResponse.json(
    { id: clientId, clientId, status: "draft" },
    { status: 201 }
  );
}
