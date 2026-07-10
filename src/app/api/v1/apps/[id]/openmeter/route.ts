import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/db/index";
import { appOpenMeterConfig } from "@/db/schema";
import { authenticateAppClient } from "@/lib/auth";
import { getAuthorizedProviderApp, getProviderApp } from "@/lib/provider-apps";
import {
  encodeApiKeyForStorage,
  getAppOpenMeterConfigRow,
  resolveNetworkFeeMeterSlug,
} from "@/lib/openmeter/client-factory";
import type { OpenMeterBackendMode } from "@/lib/openmeter/constants";

async function authorizeApp(request: NextRequest, clientId: string) {
  const clientAuth = await authenticateAppClient(request);
  if (clientAuth?.appId === clientId) {
    const app = await getProviderApp(clientId);
    return app ? { app } : null;
  }
  try {
    const providerAuth = await getAuthorizedProviderApp(clientId);
    return providerAuth ? { app: providerAuth.app } : null;
  } catch {
    return null;
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const access = await authorizeApp(request, clientId);
  if (!access) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const row = await getAppOpenMeterConfigRow(access.app.id);
  return NextResponse.json({
    clientId: access.app.id,
    mode: (row?.mode || "pymthouse_hosted") as OpenMeterBackendMode,
    baseUrl: row?.baseUrl || null,
    meterSlug: resolveNetworkFeeMeterSlug(row?.meterSlug),
    trialFeatureKey: row?.trialFeatureKey || "network_spend",
    hasApiKey: Boolean(row?.apiKeyEncrypted),
  });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const access = await authorizeApp(request, clientId);
  if (!access) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const mode = String(body.mode || "pymthouse_hosted") as OpenMeterBackendMode;
  const allowedModes = new Set([
    "pymthouse_hosted",
    "byo_openmeter_cloud",
    "byo_openmeter_self_hosted",
  ]);
  if (!allowedModes.has(mode)) {
    return NextResponse.json({ error: "Invalid mode" }, { status: 400 });
  }

  if (mode !== "pymthouse_hosted" && !String(body.baseUrl || "").trim()) {
    return NextResponse.json({ error: "baseUrl is required for BYO OpenMeter" }, { status: 400 });
  }

  const existing = await getAppOpenMeterConfigRow(access.app.id);
  const apiKeyEncrypted =
    typeof body.apiKey === "string" && body.apiKey.trim()
      ? encodeApiKeyForStorage(body.apiKey.trim())
      : existing?.apiKeyEncrypted || null;

  const values = {
    clientId: access.app.id,
    mode,
    baseUrl: mode === "pymthouse_hosted" ? null : String(body.baseUrl).trim(),
    apiKeyEncrypted,
    meterSlug: resolveNetworkFeeMeterSlug(
      String(body.meterSlug || existing?.meterSlug || "network_fee_usd_nanos"),
    ),
    trialFeatureKey: String(body.trialFeatureKey || existing?.trialFeatureKey || "network_spend"),
    updatedAt: new Date().toISOString(),
  };

  if (existing) {
    await db
      .update(appOpenMeterConfig)
      .set(values)
      .where(eq(appOpenMeterConfig.clientId, access.app.id));
  } else {
    await db.insert(appOpenMeterConfig).values({
      id: uuidv4(),
      ...values,
      createdAt: new Date().toISOString(),
    });
  }

  return NextResponse.json({
    clientId: access.app.id,
    mode: values.mode,
    baseUrl: values.baseUrl,
    meterSlug: values.meterSlug,
    trialFeatureKey: values.trialFeatureKey,
    hasApiKey: Boolean(values.apiKeyEncrypted),
  });
}
