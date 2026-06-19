import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/index";
import { apiKeys, planCapabilityBundles, plans, signerConfig } from "@/db/schema";
import { hashToken } from "@/lib/auth";
import { getHostedAdminClient, isHostedAdminClientAvailable } from "@/lib/openmeter/admin-client";
import { requireOpenMeterForUsageReads } from "@/lib/openmeter/constants";
import { resolveApiKeyOpenMeterSubscription } from "@/lib/openmeter/api-key-subscription";
import { resolveValidateAdminClient } from "@/lib/openmeter/validate-admin-client";
import { buildValidateResponseBody } from "@/lib/bpp/validate-response";
import {
  buildC0ValidateResponseBody,
  toCapabilityIds,
  CAPABILITY_WILDCARD,
  type BillingMode,
} from "@/lib/bpp/validate-response-c0";
import { bppValidateV2Enabled } from "@/lib/billing/feature-flags";

/** Stable provider slug for the pymthouse reference billing provider. */
const PROVIDER_SLUG = "pymthouse";

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    return NextResponse.json({ valid: false }, { status: 401 });
  }

  const token = authHeader.slice(7);
  const keyHash = hashToken(token);
  const apiKeyRows = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, keyHash))
    .limit(1);
  const apiKey = apiKeyRows[0];
  if (!apiKey || apiKey.status !== "active") {
    return NextResponse.json({ valid: false }, { status: 401 });
  }

  if (!apiKey.subscriptionId && !apiKey.openmeterSubscriptionId) {
    return NextResponse.json(
      buildValidateResponseBody({
        clientId: apiKey.clientId,
        plan: null,
        allowedModels: [],
      }),
    );
  }

  const adminClient = resolveValidateAdminClient();
  if (adminClient) {
    const resolved = await resolveApiKeyOpenMeterSubscription({
      apiKey,
      client: adminClient,
    });
    if (!resolved) {
      return NextResponse.json({ valid: false }, { status: 401 });
    }

    if (!resolved.planId) {
      return NextResponse.json(
        buildValidateResponseBody({
          clientId: apiKey.clientId,
          plan: null,
          allowedModels: [],
          openmeterSubscriptionId: resolved.openmeterSubscriptionId,
        }),
      );
    }

    const planRows = await db
      .select()
      .from(plans)
      .where(eq(plans.id, resolved.planId))
      .limit(1);
    const plan = planRows[0];
    if (!plan) {
      return NextResponse.json({ valid: false }, { status: 401 });
    }

    const capabilities = await db
      .select()
      .from(planCapabilityBundles)
      .where(eq(planCapabilityBundles.planId, plan.id));

    return NextResponse.json(
      buildValidateResponseBody({
        clientId: apiKey.clientId,
        openmeterSubscriptionId: resolved.openmeterSubscriptionId,
        plan: {
          ...plan,
          includedUnits: plan.includedUnits != null ? plan.includedUnits.toString() : null,
          overageRateUsd: plan.overageRateUsd ?? null,
        },
        allowedModels: capabilities.map((bundle) => bundle.modelId).filter(Boolean),
      }),
    );
  }

  // Hard cutover: subscription-backed API keys require OpenMeter to validate.
  // When OPENMETER_URL / the hosted admin client is unavailable (the branch above
  // is skipped), there is intentionally no Postgres-only fallback — reject the
  // key rather than honoring a legacy local subscription row.
  return NextResponse.json({ valid: false }, { status: 401 });
}

// ---------------------------------------------------------------------------
// PYMT-3 — additive, C0-conformant `validate` (POST {key})
//
// The legacy `GET` above is intentionally left untouched (deprecated, not
// removed) for current consumers. `POST /api/v1/auth/validate` is the NEW
// provider-neutral front door that conforms to the C0 `validate.schema.json`:
//   { valid, user.sub, billing_account, capabilities[pipeline:model], quota,
//     subscriptionRef?, signerSession? }
//
// It is gated behind `BPP_VALIDATE_V2` (default OFF). Flag-off → 404, so the
// endpoint behaves as if absent and the legacy GET path is the only behavior
// in production until the NaaP front door (NAAP-C) is ready (gated by D0).
// ---------------------------------------------------------------------------

type ApiKeyRow = typeof apiKeys.$inferSelect;

/** Neutral, stable subject id for a resolved API key (never a metering id). */
function resolveSubject(apiKey: ApiKeyRow): string {
  return apiKey.appUserId || apiKey.userId || `app:${apiKey.clientId}`;
}

/** Resolve the singleton signer's billing posture (delegated by default). */
async function resolveBillingMode(): Promise<BillingMode> {
  const rows = await db.select({ billingMode: signerConfig.billingMode }).from(signerConfig).limit(1);
  return rows[0]?.billingMode === "prepay" ? "prepay" : "delegated";
}

/** Read `{ key }` from a JSON body without throwing on malformed input. */
async function readKeyFromBody(request: NextRequest): Promise<string | null> {
  try {
    const body = (await request.json()) as unknown;
    if (body && typeof body === "object" && "key" in body) {
      const key = (body as { key?: unknown }).key;
      if (typeof key === "string" && key.length > 0) {
        return key;
      }
    }
  } catch {
    // Malformed/empty body → treated as a missing key below.
  }
  return null;
}

export async function POST(request: NextRequest) {
  if (!bppValidateV2Enabled()) {
    // Endpoint not enabled — behave as if it does not exist (zero regression).
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const key = await readKeyFromBody(request);
  if (!key) {
    return NextResponse.json({ valid: false }, { status: 400 });
  }

  const keyHash = hashToken(key);
  const apiKeyRows = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, keyHash))
    .limit(1);
  const apiKey = apiKeyRows[0];
  if (!apiKey || apiKey.status !== "active") {
    return NextResponse.json({ valid: false }, { status: 401 });
  }

  const billingMode = await resolveBillingMode();
  const billingAccount = {
    // Account of record = the developer app (per PR #149 coordination header:
    // D2/PYMT-1 dropped — no separate billing-account entity). Neutral, app-facing.
    id: apiKey.clientId,
    providerSlug: PROVIDER_SLUG,
    billingMode,
  };

  // No subscription on the key → delegated MVP: capabilities = all, quota = null.
  if (!apiKey.subscriptionId && !apiKey.openmeterSubscriptionId) {
    return NextResponse.json(
      buildC0ValidateResponseBody({
        sub: resolveSubject(apiKey),
        billingAccount,
        capabilities: [CAPABILITY_WILDCARD],
        quota: null,
      }),
    );
  }

  if (requireOpenMeterForUsageReads() && isHostedAdminClientAvailable()) {
    const resolved = await resolveApiKeyOpenMeterSubscription({
      apiKey,
      client: getHostedAdminClient(),
    });
    if (!resolved) {
      return NextResponse.json({ valid: false }, { status: 401 });
    }

    // Subscription resolved but no local plan → delegated MVP: all capabilities.
    if (!resolved.planId) {
      return NextResponse.json(
        buildC0ValidateResponseBody({
          sub: resolveSubject(apiKey),
          billingAccount,
          capabilities: [CAPABILITY_WILDCARD],
          quota: null,
          openmeterSubscriptionId: resolved.openmeterSubscriptionId,
        }),
      );
    }

    const planRows = await db
      .select()
      .from(plans)
      .where(eq(plans.id, resolved.planId))
      .limit(1);
    const plan = planRows[0];
    if (!plan) {
      return NextResponse.json({ valid: false }, { status: 401 });
    }

    const bundles = await db
      .select()
      .from(planCapabilityBundles)
      .where(eq(planCapabilityBundles.planId, plan.id));

    return NextResponse.json(
      buildC0ValidateResponseBody({
        sub: resolveSubject(apiKey),
        billingAccount,
        capabilities: toCapabilityIds(bundles),
        quota: null,
        openmeterSubscriptionId: resolved.openmeterSubscriptionId,
      }),
    );
  }

  // Hard cutover parity with GET: subscription-backed keys require OpenMeter.
  return NextResponse.json({ valid: false }, { status: 401 });
}
