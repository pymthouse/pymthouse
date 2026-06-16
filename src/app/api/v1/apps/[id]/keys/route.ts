import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/next-auth-options";
import { db } from "@/db/index";
import { apiKeys, subscriptions } from "@/db/schema";
import { hashToken } from "@/lib/auth";
import { getHostedAdminClient, isHostedAdminClientAvailable } from "@/lib/openmeter/admin-client";
import { isOpenMeterUlid } from "@/lib/openmeter/konnect-routes";
import {
  isOpenMeterSubscriptionActive,
  verifyOpenMeterSubscriptionId,
} from "@/lib/openmeter/subscription-read";
import { generateApiKeyValue } from "@/lib/oidc/programmatic-tokens";
import {
  canEditProviderApp,
  getAuthorizedProviderApp,
  appEditForbiddenResponse,
} from "@/lib/provider-apps";
import { createCorrelationId, writeAuditLog } from "@/lib/audit";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const auth = await getAuthorizedProviderApp(clientId);
  if (!auth) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const appId = auth.app.id;

  // Return all keys (including revoked) for audit visibility
  const keys = await db
    .select({
      id: apiKeys.id,
      clientId: apiKeys.clientId,
      userId: apiKeys.userId,
      subscriptionId: apiKeys.subscriptionId,
      openmeterSubscriptionId: apiKeys.openmeterSubscriptionId,
      label: apiKeys.label,
      status: apiKeys.status,
      createdAt: apiKeys.createdAt,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.clientId, appId));
  return NextResponse.json({
    keys: keys.map((key) => ({
      ...key,
      clientId,
    })),
  });
}

async function resolveOpenMeterSubscriptionIdForNewKey(input: {
  appId: string;
  subscriptionId: string | null;
  openmeterSubscriptionId: string | null;
}): Promise<
  | { ok: true; openmeterSubscriptionId: string | null }
  | { ok: false; error: "openmeter_unavailable" | "subscription_not_found" }
> {
  let openmeterSubscriptionId = input.openmeterSubscriptionId;

  if (!openmeterSubscriptionId && input.subscriptionId && isOpenMeterUlid(input.subscriptionId)) {
    openmeterSubscriptionId = input.subscriptionId;
  }

  if (openmeterSubscriptionId) {
    if (!isHostedAdminClientAvailable()) {
      return { ok: false, error: "openmeter_unavailable" };
    }
    const omSub = await verifyOpenMeterSubscriptionId(
      getHostedAdminClient(),
      openmeterSubscriptionId,
    );
    if (!omSub || !isOpenMeterSubscriptionActive(omSub.status)) {
      return { ok: false, error: "subscription_not_found" };
    }
    return { ok: true, openmeterSubscriptionId };
  }

  if (!input.subscriptionId) {
    return { ok: true, openmeterSubscriptionId: null };
  }

  const subRows = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.id, input.subscriptionId),
        eq(subscriptions.clientId, input.appId),
      ),
    )
    .limit(1);
  const subscription = subRows[0];
  if (!subscription) {
    return { ok: false, error: "subscription_not_found" };
  }
  return { ok: true, openmeterSubscriptionId: subscription.openmeterSubscriptionId ?? null };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const auth = await getAuthorizedProviderApp(clientId);
  if (!auth) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const appId = auth.app.id;

  if (!(await canEditProviderApp(auth))) {
    return appEditForbiddenResponse();
  }

  const session = await getServerSession(authOptions);
  const userId = (session?.user as Record<string, unknown> | undefined)?.id as string | undefined;
  const body = await request.json().catch(() => ({}));

  const subscriptionId = typeof body.subscriptionId === "string" ? body.subscriptionId : null;
  const requestedOpenMeterSubscriptionId =
    typeof body.openmeterSubscriptionId === "string"
      ? body.openmeterSubscriptionId.trim()
      : null;

  const resolved = await resolveOpenMeterSubscriptionIdForNewKey({
    appId,
    subscriptionId,
    openmeterSubscriptionId: requestedOpenMeterSubscriptionId,
  });

  if (!resolved.ok) {
    if (resolved.error === "openmeter_unavailable") {
      return NextResponse.json({ error: "OpenMeter not configured" }, { status: 503 });
    }
    return NextResponse.json({ error: "OpenMeter subscription not found" }, { status: 404 });
  }

  const openmeterSubscriptionId = resolved.openmeterSubscriptionId;

  const apiKeyValue = generateApiKeyValue();
  const apiKey = {
    id: uuidv4(),
    keyHash: hashToken(apiKeyValue),
    userId: userId || null,
    clientId: appId,
    subscriptionId: openmeterSubscriptionId ? null : subscriptionId,
    openmeterSubscriptionId,
    label: typeof body.label === "string" ? body.label : null,
    status: "active",
    createdAt: new Date().toISOString(),
    revokedAt: null,
  };

  await db.insert(apiKeys).values(apiKey);

  const correlationId = createCorrelationId();
  await writeAuditLog({
    clientId: appId,
    actorUserId: userId || null,
    action: "api_key_created",
    status: "success",
    correlationId,
    metadata: {
      keyId: apiKey.id,
      subscriptionId: apiKey.subscriptionId,
      openmeterSubscriptionId: apiKey.openmeterSubscriptionId,
      label: apiKey.label,
    },
  });

  return NextResponse.json(
    {
      apiKey: apiKeyValue,
      id: apiKey.id,
      message: "Store this API key securely. It will not be shown again.",
      correlation_id: correlationId,
    },
    { status: 201 },
  );
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const auth = await getAuthorizedProviderApp(clientId);
  if (!auth) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const appId = auth.app.id;

  if (!(await canEditProviderApp(auth))) {
    return appEditForbiddenResponse();
  }

  const { searchParams } = new URL(request.url);
  const keyId = searchParams.get("keyId");
  if (!keyId) {
    return NextResponse.json({ error: "keyId is required" }, { status: 400 });
  }

  const revoked = await db
    .update(apiKeys)
    .set({
      status: "revoked",
      revokedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(apiKeys.id, keyId),
        eq(apiKeys.clientId, appId),
      ),
    )
    .returning({ id: apiKeys.id });

  if (revoked.length === 0) {
    return NextResponse.json({ error: "Key not found" }, { status: 404 });
  }

  const session = await getServerSession(authOptions);
  const actorUserId = (session?.user as Record<string, unknown> | undefined)?.id as string | undefined;
  const correlationId = createCorrelationId();
  await writeAuditLog({
    clientId: appId,
    actorUserId: actorUserId || null,
    action: "api_key_revoked",
    status: "success",
    correlationId,
    metadata: { keyId },
  });

  return NextResponse.json({ success: true, correlation_id: correlationId });
}
