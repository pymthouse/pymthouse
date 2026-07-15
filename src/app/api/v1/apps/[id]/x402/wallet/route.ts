import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { developerApps } from "@/db/schema";
import { requireAppClient } from "@/lib/api-guards";
import {
  assignM2mDepositWallet,
  provisionAppX402Wallet,
} from "@/lib/x402/wallets";

/**
 * POST /api/v1/apps/{clientId}/x402/wallet
 * Provision/assign deposit wallet for the app or its M2M client.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const auth = await requireAppClient(request, "x402:settle");
  if (!auth.ok) {
    return auth.response;
  }
  if (auth.context.appId !== clientId && auth.context.clientId !== clientId) {
    // Path clientId must match the authenticated app (public id preferred).
    const appRows = await db
      .select({ id: developerApps.id })
      .from(developerApps)
      .where(eq(developerApps.id, auth.context.appId))
      .limit(1);
    if (!appRows[0] || appRows[0].id !== auth.context.appId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (clientId !== auth.context.appId) {
      return NextResponse.json({ error: "clientId mismatch" }, { status: 403 });
    }
  }

  const appRows = await db
    .select()
    .from(developerApps)
    .where(eq(developerApps.id, auth.context.appId))
    .limit(1);
  const app = appRows[0];
  if (!app) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (app.x402Enabled !== 1) {
    return NextResponse.json(
      { error: "x402 payments are not enabled for this app" },
      { status: 403 },
    );
  }

  let body: { address?: string; target?: "app" | "m2m" } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  try {
    if (body.target === "m2m") {
      const wallet = await assignM2mDepositWallet({
        appId: app.id,
        address: body.address,
      });
      return NextResponse.json({ target: "m2m", ...wallet });
    }
    const wallet = await provisionAppX402Wallet({
      appId: app.id,
      address: body.address,
    });
    return NextResponse.json({ target: "app", ...wallet });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Wallet provisioning failed" },
      { status: 500 },
    );
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const auth = await requireAppClient(request);
  if (!auth.ok) {
    return auth.response;
  }
  if (clientId !== auth.context.appId) {
    return NextResponse.json({ error: "clientId mismatch" }, { status: 403 });
  }

  const appRows = await db
    .select({
      x402Enabled: developerApps.x402Enabled,
      x402PayToAddress: developerApps.x402PayToAddress,
      turnkeySubOrgId: developerApps.turnkeySubOrgId,
      turnkeyWalletId: developerApps.turnkeyWalletId,
    })
    .from(developerApps)
    .where(eq(developerApps.id, auth.context.appId))
    .limit(1);
  const app = appRows[0];
  if (!app) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    x402Enabled: app.x402Enabled === 1,
    address: app.x402PayToAddress,
    turnkeySubOrgId: app.turnkeySubOrgId,
    turnkeyWalletId: app.turnkeyWalletId,
  });
}
