import { NextRequest, NextResponse } from "next/server";
import {
  canManageMerchantBilling,
  getAuthorizedProviderApp,
  merchantBillingForbiddenResponse,
} from "@/lib/provider-apps";
import { getAppOpenMeterConfigRow } from "@/lib/openmeter/client-factory";
import { sanitizeForLog } from "@/lib/sanitize-for-log";
import {
  startMerchantConnect,
  type MerchantConnectMode,
} from "@/lib/stripe/merchant-connect";
import { merchantConnectOAuthErrorCode } from "@/lib/stripe/webhook";

type ConnectBodyParse =
  | {
      ok: true;
      mode: MerchantConnectMode;
      stripeLivemode?: boolean;
      email?: string;
      displayName?: string;
    }
  | { ok: false; response: NextResponse };

function parseMerchantConnectBody(
  body: Record<string, unknown>,
): ConnectBodyParse {
  const modeRaw =
    typeof body.mode === "string" ? body.mode.trim() : "account_link";
  if (modeRaw === "oauth") {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error:
            'Standard Connect OAuth is no longer supported. Use mode "account_link" (Stripe Account Links).',
        },
        { status: 400 },
      ),
    };
  }
  if (modeRaw !== "account_link") {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'mode must be "account_link"' },
        { status: 400 },
      ),
    };
  }
  if (
    body.stripeLivemode !== undefined &&
    typeof body.stripeLivemode !== "boolean"
  ) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "stripeLivemode must be a boolean" },
        { status: 400 },
      ),
    };
  }
  return {
    ok: true,
    mode: modeRaw,
    stripeLivemode:
      typeof body.stripeLivemode === "boolean" ? body.stripeLivemode : undefined,
    email: typeof body.email === "string" ? body.email : undefined,
    displayName:
      typeof body.displayName === "string" ? body.displayName : undefined,
  };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const auth = await getAuthorizedProviderApp(clientId, request);
  if (!auth) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!(await canManageMerchantBilling(auth))) {
    return merchantBillingForbiddenResponse();
  }

  const omConfig = await getAppOpenMeterConfigRow(auth.app.id);
  if ((omConfig?.mode || "pymthouse_hosted") !== "pymthouse_hosted") {
    return NextResponse.json(
      { error: "Billing connect requires pymthouse_hosted OpenMeter mode" },
      { status: 400 },
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const parsed = parseMerchantConnectBody(body);
  if (!parsed.ok) {
    return parsed.response;
  }

  try {
    const result = await startMerchantConnect({
      clientId: auth.app.id,
      userId: auth.userId,
      mode: parsed.mode,
      email: parsed.email,
      displayName: parsed.displayName,
      stripeLivemode: parsed.stripeLivemode,
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      "[stripe-connect]",
      "startMerchantConnect failed:",
      sanitizeForLog(message),
    );
    const code = merchantConnectOAuthErrorCode(err);
    const status = code === "connect_misconfigured" ? 400 : 502;
    return NextResponse.json({ error: code }, { status });
  }
}
