import { NextRequest, NextResponse } from "next/server";

import {
  platformControlledFieldsError,
  platformControlledFieldsInBody,
} from "@/lib/billing/platform-controlled-fields";
import {
  canManageMerchantBilling,
  getAuthorizedProviderApp,
  merchantBillingForbiddenResponse,
} from "@/lib/provider-apps";
import {
  getAppBillingConfig,
  updateAppBillingProfileSettings,
  upsertAppBillingConfig,
} from "@/lib/openmeter/billing-profiles";
import {
  parseInvoiceThresholdUsdMicrosInput,
  parseProgressiveBillingInput,
} from "@/lib/openmeter/billing-profile-settings";
import {
  disconnectStripeConnect,
  getStripeConnectStatus,
} from "@/lib/openmeter/stripe-app-install";
import { getAppOpenMeterConfigRow } from "@/lib/openmeter/client-factory";
import { isConnectReady } from "@/lib/activation/app-activation";
import { sanitizeForLog } from "@/lib/sanitize-for-log";

type BillingPatchFields = {
  progressiveBilling?: boolean;
  invoiceThresholdUsdMicros?: string | null;
  applicationFeeBps?: number;
  billingMode?: "owner_rollup" | "merchant";
  endUserCap?: number;
  supplierTaxId?: string | null;
};

type ParseResult =
  | { ok: true; fields: BillingPatchFields }
  | { ok: false; response: NextResponse };

async function requireHostedBillingApp(clientId: string) {
  const auth = await getAuthorizedProviderApp(clientId);
  if (!auth) {
    return null;
  }
  const omConfig = await getAppOpenMeterConfigRow(auth.app.id);
  const mode = omConfig?.mode || "pymthouse_hosted";
  if (mode !== "pymthouse_hosted") {
    return {
      auth,
      error: NextResponse.json(
        { error: "Billing connect requires pymthouse_hosted OpenMeter mode" },
        { status: 400 },
      ),
    };
  }
  return { auth, error: null as NextResponse | null };
}

function parseIntegerField(
  value: unknown,
  label: string,
  min: number,
  max: number,
): { ok: true; value: number } | { ok: false; response: NextResponse } {
  let n: number;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string") {
    n = Number.parseInt(value, 10);
  } else {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `${label} must be an integer from ${min} to ${max}` },
        { status: 400 },
      ),
    };
  }
  if (!Number.isInteger(n) || n < min || n > max) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `${label} must be an integer from ${min} to ${max}` },
        { status: 400 },
      ),
    };
  }
  return { ok: true, value: n };
}

async function refreshConfigAfterSupplierSync(
  appId: string,
  config: Awaited<ReturnType<typeof getAppBillingConfig>>,
): Promise<Awaited<ReturnType<typeof getAppBillingConfig>>> {
  const accountId = config?.stripeConnectedAccountId?.trim();
  if (!accountId) {
    return config;
  }
  try {
    const { syncTenantSupplierFromConnect } = await import(
      "@/lib/openmeter/supplier-sync"
    );
    await syncTenantSupplierFromConnect({
      clientId: appId,
      accountId,
    });
    return await getAppBillingConfig(appId);
  } catch (err) {
    console.warn(
      "supplier sync before merchant mode switch failed",
      sanitizeForLog(err instanceof Error ? err.message : String(err)),
    );
    return config;
  }
}

async function rejectIfSupplierIncomplete(
  config: Awaited<ReturnType<typeof getAppBillingConfig>>,
  fields: BillingPatchFields,
): Promise<ParseResult | null> {
  const { supplierGaps, supplierIsComplete } = await import(
    "@/lib/openmeter/billing-supplier"
  );
  const pendingTaxId =
    fields.supplierTaxId !== undefined
      ? fields.supplierTaxId
      : config?.supplierTaxId;
  const supplierInput = {
    country: config?.supplierCountry,
    name: config?.supplierName,
    taxId: pendingTaxId,
  };
  if (supplierIsComplete(supplierInput)) {
    return null;
  }
  return {
    ok: false,
    response: NextResponse.json(
      {
        error:
          "Switching to merchant mode requires a complete invoice supplier (country, legal name, and tax id where required). Complete Connect onboarding and set supplierTaxId if needed.",
        supplierGaps: supplierGaps(supplierInput),
      },
      { status: 400 },
    ),
  };
}

async function ensureMerchantModeReady(
  appId: string,
  fields: BillingPatchFields,
): Promise<ParseResult | null> {
  let config = await getAppBillingConfig(appId);
  if (!isConnectReady(config)) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error:
            "Switching to merchant mode requires a ready Stripe Connected Account (charges enabled and details submitted)",
        },
        { status: 400 },
      ),
    };
  }
  // Self-heal: Connect may be ready before webhook/status synced supplier
  // country/name into Neon. Refresh from Stripe before gating.
  config = await refreshConfigAfterSupplierSync(appId, config);
  return rejectIfSupplierIncomplete(config, fields);
}

async function applyBillingModeField(
  value: unknown,
  appId: string,
  fields: BillingPatchFields,
): Promise<ParseResult | null> {
  if (value === undefined) {
    return null;
  }
  if (value !== "owner_rollup" && value !== "merchant") {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'billingMode must be "owner_rollup" or "merchant"' },
        { status: 400 },
      ),
    };
  }
  fields.billingMode = value;
  if (fields.billingMode !== "merchant") {
    return null;
  }
  return ensureMerchantModeReady(appId, fields);
}

function applyIntegerPatchField(
  value: unknown,
  label: string,
  min: number,
  max: number,
  assign: (n: number) => void,
): ParseResult | null {
  if (value === undefined) {
    return null;
  }
  const parsed = parseIntegerField(value, label, min, max);
  if (!parsed.ok) return parsed;
  assign(parsed.value);
  return null;
}

function hasBillingPatchFields(body: Record<string, unknown>): boolean {
  return (
    body.progressiveBilling !== undefined ||
    body.invoiceThresholdUsdMicros !== undefined ||
    body.applicationFeeBps !== undefined ||
    body.billingMode !== undefined ||
    body.endUserCap !== undefined ||
    body.supplierTaxId !== undefined
  );
}

function applySupplierTaxIdField(
  value: unknown,
  fields: BillingPatchFields,
): ParseResult | null {
  if (value === undefined) {
    return null;
  }
  if (value !== null && typeof value !== "string") {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "supplierTaxId must be a string or null" },
        { status: 400 },
      ),
    };
  }
  fields.supplierTaxId =
    typeof value === "string" ? value.trim() || null : null;
  return null;
}

function applyProgressiveBillingField(
  value: unknown,
  fields: BillingPatchFields,
): ParseResult | null {
  if (value === undefined) {
    return null;
  }
  const parsed = parseProgressiveBillingInput(value);
  if (!parsed.ok) {
    return {
      ok: false,
      response: NextResponse.json({ error: parsed.error }, { status: 400 }),
    };
  }
  fields.progressiveBilling = parsed.value;
  return null;
}

function applyInvoiceThresholdField(
  value: unknown,
  fields: BillingPatchFields,
): ParseResult | null {
  if (value === undefined) {
    return null;
  }
  const parsed = parseInvoiceThresholdUsdMicrosInput(value);
  if (!parsed.ok) {
    return {
      ok: false,
      response: NextResponse.json({ error: parsed.error }, { status: 400 }),
    };
  }
  fields.invoiceThresholdUsdMicros = parsed.value;
  return null;
}

async function parseBillingPatchBody(
  body: Record<string, unknown>,
  appId: string,
): Promise<ParseResult> {
  if (!hasBillingPatchFields(body)) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error:
            "Provide progressiveBilling, invoiceThresholdUsdMicros, applicationFeeBps, billingMode, endUserCap, and/or supplierTaxId to update",
        },
        { status: 400 },
      ),
    };
  }

  const fields: BillingPatchFields = {};

  const taxErr = applySupplierTaxIdField(body.supplierTaxId, fields);
  if (taxErr) return taxErr;

  const progressiveErr = applyProgressiveBillingField(
    body.progressiveBilling,
    fields,
  );
  if (progressiveErr) return progressiveErr;

  const thresholdErr = applyInvoiceThresholdField(
    body.invoiceThresholdUsdMicros,
    fields,
  );
  if (thresholdErr) return thresholdErr;

  const feeErr = applyIntegerPatchField(
    body.applicationFeeBps,
    "applicationFeeBps",
    0,
    10_000,
    (n) => {
      fields.applicationFeeBps = n;
    },
  );
  if (feeErr) return feeErr;

  const modeErr = await applyBillingModeField(body.billingMode, appId, fields);
  if (modeErr) return modeErr;

  const capErr = applyIntegerPatchField(
    body.endUserCap,
    "endUserCap",
    1,
    1_000_000,
    (n) => {
      fields.endUserCap = n;
    },
  );
  if (capErr) return capErr;

  return { ok: true, fields };
}

function openMeterPatchHttpStatus(message: string): number {
  if (message.includes("not configured")) return 400;
  if (message.includes("Cannot reach OpenMeter")) return 503;
  return 502;
}

/** 403 when a non-admin PATCH tries to set platform-controlled fields. */
function rejectPlatformControlledForNonAdmin(
  role: string | undefined,
  body: Record<string, unknown>,
): NextResponse | null {
  if (role === "admin") return null;
  const attempted = platformControlledFieldsInBody(body);
  if (attempted.length === 0) return null;
  return NextResponse.json(
    { error: platformControlledFieldsError(attempted) },
    { status: 403 },
  );
}

async function persistBillingPatch(
  appId: string,
  fields: BillingPatchFields,
): Promise<Record<string, unknown>> {
  const {
    progressiveBilling,
    invoiceThresholdUsdMicros,
    applicationFeeBps,
    billingMode,
    endUserCap,
    supplierTaxId,
  } = fields;
  // Persist OpenMeter profile settings before Neon billingMode/endUserCap so
  // a failed OM write cannot leave the app on a new revenue plane.
  const updated =
    progressiveBilling !== undefined ||
    invoiceThresholdUsdMicros !== undefined ||
    applicationFeeBps !== undefined
      ? await updateAppBillingProfileSettings({
          clientId: appId,
          progressiveBilling,
          invoiceThresholdUsdMicros,
          applicationFeeBps,
        })
      : {};

  if (supplierTaxId !== undefined) {
    const { setAppSupplierTaxId } = await import(
      "@/lib/openmeter/supplier-sync"
    );
    await setAppSupplierTaxId({ clientId: appId, taxId: supplierTaxId });
  }

  if (billingMode !== undefined || endUserCap !== undefined) {
    await upsertAppBillingConfig(appId, {
      ...(billingMode !== undefined ? { billingMode } : {}),
      ...(endUserCap !== undefined ? { endUserCap } : {}),
    });
  }
  return updated;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const access = await requireHostedBillingApp(clientId);
  if (!access) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (access.error) {
    return access.error;
  }

  const status = await getStripeConnectStatus(access.auth.app.id);
  return NextResponse.json({
    clientId: access.auth.app.id,
    ...status,
    // Drives whether the Payments tab offers the platform-controlled fields as
    // editable inputs or as read-only, platform-attributed values.
    isPlatformAdmin: access.auth.role === "admin",
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const access = await requireHostedBillingApp(clientId);
  if (!access) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (access.error) {
    return access.error;
  }
  if (!(await canManageMerchantBilling(access.auth))) {
    return merchantBillingForbiddenResponse();
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // canManageMerchantBilling admits the app owner, which is correct for
  // revenue-rail settings but not for the platform's own controls.
  const platformReject = rejectPlatformControlledForNonAdmin(
    access.auth.role,
    body,
  );
  if (platformReject) {
    return platformReject;
  }

  const parsed = await parseBillingPatchBody(body, access.auth.app.id);
  if (!parsed.ok) {
    return parsed.response;
  }

  try {
    const updated = await persistBillingPatch(
      access.auth.app.id,
      parsed.fields,
    );
    const status = await getStripeConnectStatus(access.auth.app.id);
    return NextResponse.json({
      clientId: access.auth.app.id,
      ...status,
      ...updated,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message },
      { status: openMeterPatchHttpStatus(message) },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const access = await requireHostedBillingApp(clientId);
  if (!access) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (access.error) {
    return access.error;
  }
  if (!(await canManageMerchantBilling(access.auth))) {
    return merchantBillingForbiddenResponse();
  }

  await disconnectStripeConnect(access.auth.app.id);
  return NextResponse.json({ success: true });
}
