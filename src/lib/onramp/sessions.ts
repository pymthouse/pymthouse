import { and, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/db/index";
import { appUsers, onrampSessions } from "@/db/schema";
import { provisionAppUserBilling } from "@/lib/billing/provision-app-user";
import { grantAllowanceUsdMicros } from "@/lib/openmeter/grant-allowance";
import { fiatAmountToUsdMicros } from "./amount";
import { verifyOnRampTransactionStatus } from "./turnkey-client";

export type OnrampSessionStatus = "pending" | "completed" | "failed" | "cancelled";

const TERMINAL_FAILURE_STATUSES = new Set(["FAILED", "CANCELLED"]);

async function resolveExistingOnRampSession(input: {
  clientId: string;
  onRampTransactionId: string;
  turnkeyOrganizationId: string | null;
  now: string;
}): Promise<{
  id: string;
  status: OnrampSessionStatus;
  onRampTransactionId: string;
}> {
  const existingRows = await db
    .select()
    .from(onrampSessions)
    .where(eq(onrampSessions.onrampTransactionId, input.onRampTransactionId))
    .limit(1);
  const existing = existingRows[0];
  if (!existing) {
    throw new Error("on-ramp transaction id conflict without existing row");
  }
  if (existing.clientId !== input.clientId) {
    throw new Error("on-ramp transaction id belongs to another app");
  }

  if (input.turnkeyOrganizationId && !existing.turnkeyOrganizationId) {
    await db
      .update(onrampSessions)
      .set({ turnkeyOrganizationId: input.turnkeyOrganizationId, updatedAt: input.now })
      .where(eq(onrampSessions.id, existing.id));
  }

  return {
    id: existing.id,
    status: existing.status as OnrampSessionStatus,
    onRampTransactionId: existing.onrampTransactionId,
  };
}

export async function createOnRampSession(input: {
  clientId: string;
  externalUserId: string;
  depositWalletAddress: string;
  onRampTransactionId: string;
  turnkeyOrganizationId?: string;
  onrampProvider?: string;
  fiatCurrencyCode?: string;
  fiatAmount?: string;
}): Promise<{
  id: string;
  status: OnrampSessionStatus;
  onRampTransactionId: string;
}> {
  const clientId = input.clientId.trim();
  const externalUserId = input.externalUserId.trim();
  const depositWalletAddress = input.depositWalletAddress.trim();
  const onRampTransactionId = input.onRampTransactionId.trim();
  const turnkeyOrganizationId = input.turnkeyOrganizationId?.trim() || null;

  if (!externalUserId || !depositWalletAddress || !onRampTransactionId) {
    throw new Error("externalUserId, depositWalletAddress, and onRampTransactionId are required");
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(depositWalletAddress)) {
    throw new Error("depositWalletAddress must be a valid EVM address");
  }

  await provisionAppUserBilling({ clientId, externalUserId });

  const appUserRows = await db
    .select()
    .from(appUsers)
    .where(
      and(eq(appUsers.clientId, clientId), eq(appUsers.externalUserId, externalUserId)),
    )
    .limit(1);
  const appUser = appUserRows[0];
  if (appUser && appUser.depositWalletAddress !== depositWalletAddress) {
    await db
      .update(appUsers)
      .set({ depositWalletAddress })
      .where(eq(appUsers.id, appUser.id));
  }

  const now = new Date().toISOString();
  const sessionId = uuidv4();

  try {
    await db.insert(onrampSessions).values({
      id: sessionId,
      clientId,
      externalUserId,
      depositWalletAddress,
      onrampTransactionId: onRampTransactionId,
      onrampProvider: input.onrampProvider?.trim() || "moonpay",
      turnkeyOrganizationId,
      fiatCurrencyCode: input.fiatCurrencyCode?.trim() || null,
      fiatAmount: input.fiatAmount?.trim() || null,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.toLowerCase().includes("unique")) {
      throw error;
    }
    return resolveExistingOnRampSession({
      clientId,
      onRampTransactionId,
      turnkeyOrganizationId,
      now,
    });
  }

  return {
    id: sessionId,
    status: "pending",
    onRampTransactionId,
  };
}

export async function settleOnRampSession(input: {
  clientId: string;
  sessionId: string;
}): Promise<{
  sessionId: string;
  status: OnrampSessionStatus;
  grantedUsdMicros: string | null;
  balanceUsdMicros: string | null;
  externalUserId: string;
}> {
  const clientId = input.clientId.trim();
  const sessionId = input.sessionId.trim();

  const rows = await db
    .select()
    .from(onrampSessions)
    .where(and(eq(onrampSessions.id, sessionId), eq(onrampSessions.clientId, clientId)))
    .limit(1);
  const session = rows[0];
  if (!session) {
    throw new Error("on-ramp session not found");
  }

  if (session.status === "completed") {
    return {
      sessionId: session.id,
      status: "completed",
      grantedUsdMicros: session.grantedUsdMicros,
      balanceUsdMicros: null,
      externalUserId: session.externalUserId,
    };
  }

  const turnkeyStatus = await verifyOnRampTransactionStatus({
    transactionId: session.onrampTransactionId,
    organizationId: session.turnkeyOrganizationId || undefined,
    refresh: true,
  });

  const now = new Date().toISOString();

  if (turnkeyStatus !== "COMPLETED") {
    let nextStatus: OnrampSessionStatus = "pending";
    if (TERMINAL_FAILURE_STATUSES.has(turnkeyStatus)) {
      nextStatus = turnkeyStatus === "CANCELLED" ? "cancelled" : "failed";
    }

    if (nextStatus !== "pending") {
      await db
        .update(onrampSessions)
        .set({ status: nextStatus, updatedAt: now })
        .where(eq(onrampSessions.id, session.id));
    }

    throw new Error(
      nextStatus === "pending"
        ? `on-ramp transaction not completed (status=${turnkeyStatus || "unknown"})`
        : `on-ramp transaction ${nextStatus}`,
    );
  }

  const fiatCurrencyCode = session.fiatCurrencyCode?.trim() || "USD";
  const fiatAmount = session.fiatAmount?.trim();
  if (!fiatAmount) {
    throw new Error("session is missing fiat amount for allowance credit");
  }

  const amountUsdMicros = fiatAmountToUsdMicros(fiatCurrencyCode, fiatAmount);
  const grant = await grantAllowanceUsdMicros({
    clientId,
    externalUserId: session.externalUserId,
    amountUsdMicros,
    source: "onramp",
    idempotencyKey: session.id,
  });

  await db
    .update(onrampSessions)
    .set({
      status: "completed",
      grantedUsdMicros: amountUsdMicros.toString(),
      settledAt: now,
      updatedAt: now,
    })
    .where(eq(onrampSessions.id, session.id));

  return {
    sessionId: session.id,
    status: "completed",
    grantedUsdMicros: amountUsdMicros.toString(),
    balanceUsdMicros: grant.balance?.balanceUsdMicros ?? null,
    externalUserId: session.externalUserId,
  };
}
