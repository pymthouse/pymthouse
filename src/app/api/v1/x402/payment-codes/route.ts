import { NextResponse } from "next/server";
import {
  authenticateX402AgentOrApp,
  requireX402EnabledApp,
  x402PaymentRequirementsSchema,
} from "@/lib/x402";
import { createPaymentCode } from "@/lib/x402/payment-codes";

/**
 * POST /api/v1/x402/payment-codes
 * Create a device-code-style payment approval intent for agents.
 */
export async function POST(request: Request) {
  const auth = await authenticateX402AgentOrApp(request, {
    rateLimitKeyPrefix: "x402-payment-codes",
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

  const record = body as {
    paymentRequirements?: unknown;
    externalUserId?: string;
    ttlSeconds?: number;
  };

  const requirements = x402PaymentRequirementsSchema.safeParse(
    record.paymentRequirements,
  );
  if (!requirements.success) {
    return NextResponse.json(
      { error: "Invalid paymentRequirements", details: requirements.error.flatten() },
      { status: 400 },
    );
  }

  if (
    auth.context.x402PayToAddress &&
    requirements.data.payTo.toLowerCase() !==
      auth.context.x402PayToAddress.toLowerCase()
  ) {
    return NextResponse.json(
      { error: "payTo must match the app deposit wallet" },
      { status: 400 },
    );
  }

  const created = await createPaymentCode({
    clientId: auth.context.appId,
    paymentRequirements: requirements.data,
    externalUserId:
      record.externalUserId?.trim() || auth.context.externalUserId || null,
    ttlSeconds: record.ttlSeconds,
  });

  return NextResponse.json(
    {
      device_code: created.deviceCode,
      user_code: created.userCode,
      verification_uri: created.verificationUri,
      verification_uri_complete: created.verificationUriComplete,
      expires_in: Math.max(
        0,
        Math.floor((new Date(created.expiresAt).getTime() - Date.now()) / 1000),
      ),
      interval: 3,
    },
    { status: 201 },
  );
}
