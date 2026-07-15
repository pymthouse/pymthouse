import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { x402Payments } from "@/db/schema";
import {
  authenticateX402AgentOrApp,
  requireX402EnabledApp,
  verifyExactEip3009Payment,
  x402VerifyRequestSchema,
} from "@/lib/x402";

/**
 * POST /api/v1/x402/verify
 * M2M Basic, public app_* client_id (rate-limited), or bearer JWT.
 */
export async function POST(request: Request) {
  const auth = await authenticateX402AgentOrApp(request, {
    rateLimitKeyPrefix: "x402-verify",
  });
  if (!auth.ok) {
    return auth.response;
  }
  const disabled = await requireX402EnabledApp(auth.context);
  if (disabled) {
    return disabled;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = x402VerifyRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { paymentPayload, paymentRequirements } = parsed.data;
  if (
    auth.context.x402PayToAddress &&
    paymentRequirements.payTo.toLowerCase() !==
      auth.context.x402PayToAddress.toLowerCase()
  ) {
    return NextResponse.json({
      isValid: false,
      invalidReason: "pay_to_not_registered_for_app",
    });
  }

  const result = await verifyExactEip3009Payment({
    paymentPayload,
    paymentRequirements,
  });

  if (result.isValid) {
    const authz = paymentPayload.payload.authorization;
    const existing = await db
      .select({ id: x402Payments.id })
      .from(x402Payments)
      .where(
        and(
          eq(x402Payments.asset, paymentRequirements.asset.toLowerCase()),
          eq(x402Payments.fromAddress, authz.from.toLowerCase()),
          eq(x402Payments.nonce, authz.nonce.toLowerCase()),
        ),
      )
      .limit(1);

    if (!existing[0]) {
      const now = new Date().toISOString();
      await db.insert(x402Payments).values({
        id: randomUUID(),
        clientId: auth.context.appId,
        scheme: paymentRequirements.scheme,
        network: paymentRequirements.network,
        asset: paymentRequirements.asset.toLowerCase(),
        fromAddress: authz.from.toLowerCase(),
        payTo: paymentRequirements.payTo.toLowerCase(),
        valueAtomic: authz.value,
        nonce: authz.nonce.toLowerCase(),
        status: "verified",
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  return NextResponse.json(result);
}
