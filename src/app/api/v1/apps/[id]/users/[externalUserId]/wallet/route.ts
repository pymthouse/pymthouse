import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { authenticateAppClient, authenticateRequestAsync, hasScope } from "@/lib/auth";
import { db } from "@/db/index";
import { endUsers } from "@/db/schema";
import {
  canEditProviderApp,
  getProviderApp,
  getAuthorizedProviderApp,
  appEditForbiddenResponse,
} from "@/lib/provider-apps";
import { createCorrelationId, writeAuditLog } from "@/lib/audit";
import { provisionAppUserBilling } from "@/lib/billing/provision-app-user";
import {
  attestAppEndUserWallet,
  MultiAccountWalletError,
  TurnkeyAttestationError,
  WalletBindingConflictError,
} from "@/lib/turnkey/attest-wallet";

async function canAccessUsers(
  request: NextRequest,
  clientId: string,
  requiredScope: string,
) {
  const app = await getProviderApp(clientId);
  if (!app) {
    return null;
  }

  const providerAuth = await getAuthorizedProviderApp(clientId);
  if (providerAuth) {
    return {
      app: providerAuth.app,
      actorUserId: providerAuth.userId,
      clientId: providerAuth.app.id,
    };
  }

  const bearer = await authenticateRequestAsync(request);
  if (bearer?.appId === clientId && hasScope(bearer.scopes, requiredScope)) {
    return { app, actorUserId: bearer.userId, clientId: app.id };
  }

  const clientAuth = await authenticateAppClient(request);
  if (clientAuth?.appId === clientId) {
    const required =
      requiredScope === "users:read" ? "users:read" : "users:write";
    const allowed = hasScope(clientAuth.scopes, required);
    if (allowed) {
      return { app, actorUserId: null, clientId: app.id };
    }
  }

  return null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; externalUserId: string }> },
) {
  const { id: clientId, externalUserId: raw } = await params;
  const externalUserId = decodeURIComponent(raw);
  const access = await canAccessUsers(request, clientId, "users:read");
  if (!access) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rows = await db
    .select()
    .from(endUsers)
    .where(
      and(
        eq(endUsers.appId, access.app.id),
        eq(endUsers.externalUserId, externalUserId),
      ),
    )
    .limit(1);
  const endUser = rows[0];
  if (!endUser) {
    return NextResponse.json({ error: "End user not found" }, { status: 404 });
  }

  return NextResponse.json({
    externalUserId,
    walletAddress: endUser.walletAddress,
    turnkeyOrgId: endUser.turnkeySubOrgId,
    turnkeyUserId: endUser.turnkeyUserId,
    endUserId: endUser.id,
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; externalUserId: string }> },
) {
  const { id: clientId, externalUserId: raw } = await params;
  const externalUserId = decodeURIComponent(raw).trim();
  if (!externalUserId) {
    return NextResponse.json(
      { error: "externalUserId is required" },
      { status: 400 },
    );
  }

  const providerAuth = await getAuthorizedProviderApp(clientId);
  if (providerAuth && !(await canEditProviderApp(providerAuth))) {
    return appEditForbiddenResponse();
  }

  const access = await canAccessUsers(request, clientId, "users:write");
  if (!access) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const correlationId = createCorrelationId();
  const body = (await request.json().catch(() => ({}))) as {
    turnkeySessionJwt?: string;
    walletAddress?: string;
  };

  if (!body.turnkeySessionJwt?.trim()) {
    return NextResponse.json(
      { error: "Missing turnkeySessionJwt" },
      { status: 400 },
    );
  }

  try {
    const result = await attestAppEndUserWallet({
      appId: access.app.id,
      externalUserId,
      turnkeySessionJwt: body.turnkeySessionJwt,
      walletHint: body.walletAddress,
    });

    try {
      await provisionAppUserBilling({
        clientId: access.app.id,
        externalUserId,
        walletAddress: result.walletAddress ?? undefined,
        turnkeySubOrgId: result.turnkeyOrgId,
        turnkeyUserId: result.turnkeyUserId,
      });
    } catch (err) {
      console.error("provisionAppUserBilling failed on wallet attestation:", err);
    }

    await writeAuditLog({
      clientId: access.app.id,
      actorUserId: access.actorUserId,
      action: "app_user_wallet_attested",
      status: "success",
      correlationId,
      metadata: {
        externalUserId,
        endUserId: result.endUserId,
        walletAddress: result.walletAddress,
      },
    });

    return NextResponse.json(result, { status: result.isNew ? 201 : 200 });
  } catch (err) {
    if (err instanceof MultiAccountWalletError) {
      return NextResponse.json(
        {
          error: err.message,
          attestedAddresses: err.attestedAddresses,
        },
        { status: 400 },
      );
    }
    if (err instanceof WalletBindingConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof TurnkeyAttestationError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    if (err instanceof Error && err.message.includes("Turnkey session")) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("wallet attestation failed:", err);
    return NextResponse.json(
      { error: "Wallet attestation failed", correlation_id: correlationId },
      { status: 500 },
    );
  }
}
